import { Request, Response } from 'express';
import neo4j, { Driver, Session, auth } from 'neo4j-driver';
import cypher from './cypherController';

// Singleton driver - tạo 1 lần duy nhất
let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
    const password = process.env.NEO4J_PASSWORD || 'password';
    driver = neo4j.driver(uri, auth.basic('neo4j', password), {
      disableLosslessIntegers: true,
      maxConnectionLifetime: 30 * 60 * 1000,
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 2 * 60 * 1000,
      maxTransactionRetryTime: 10 * 60 * 1000, // 10 phút retry
    });
  }
  return driver;
}

type ImportCheckpoint = {
  nextUrl: string | null;
  pageNum: number;
  totalLoaded: number;
  status: 'in_progress' | 'completed';
};

function normalizeFhirBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function rewriteNextUrl(nextUrl: string, fhirBaseUrl: string): string {
  return nextUrl
    .replace('http://hapi-fhir:8080/fhir', fhirBaseUrl)
    .replace('http://172.16.12.230:8014/fhir', fhirBaseUrl);
}

// Checkpoints live in Neo4j (rather than container memory), so they survive
// a Docker stop/down as long as the neo4j_data volume is retained.
async function getImportCheckpoint(source: string, resourceType: string): Promise<ImportCheckpoint | null> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (c:CyFHIRImportCheckpoint {source: $source, resourceType: $resourceType})
       RETURN c.nextUrl AS nextUrl, c.pageNum AS pageNum,
              c.totalLoaded AS totalLoaded, c.status AS status`,
      { source, resourceType }
    );
    if (result.records.length === 0) return null;

    const record = result.records[0];
    return {
      nextUrl: record.get('nextUrl') || null,
      pageNum: record.get('pageNum') || 0,
      totalLoaded: record.get('totalLoaded') || 0,
      status: record.get('status') === 'completed' ? 'completed' : 'in_progress'
    };
  } finally {
    await session.close();
  }
}

async function saveImportCheckpoint(
  source: string,
  resourceType: string,
  checkpoint: ImportCheckpoint
): Promise<void> {
  const session = getDriver().session();
  try {
    await session.writeTransaction(tx => tx.run(
      `MERGE (c:CyFHIRImportCheckpoint {source: $source, resourceType: $resourceType})
       SET c.nextUrl = $nextUrl,
           c.pageNum = $pageNum,
           c.totalLoaded = $totalLoaded,
           c.status = $status,
           c.updatedAt = datetime()`,
      { source, resourceType, ...checkpoint }
    ));
  } finally {
    await session.close();
  }
}

async function clearImportCheckpoints(source: string): Promise<void> {
  const session = getDriver().session();
  try {
    await session.writeTransaction(tx => tx.run(
      'MATCH (c:CyFHIRImportCheckpoint {source: $source}) DETACH DELETE c',
      { source }
    ));
  } finally {
    await session.close();
  }
}

async function setImportJobStatus(source: string, status: 'in_progress' | 'completed', error?: string): Promise<void> {
  const session = getDriver().session();
  try {
    await session.writeTransaction(tx => tx.run(
      `MERGE (j:CyFHIRImportJob {source: $source})
       SET j.status = $status,
           j.error = $error,
           j.updatedAt = datetime()`,
      { source, status, error: error || null }
    ));
  } finally {
    await session.close();
  }
}

async function getPendingImportSources(): Promise<string[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (n)
       WHERE (n:CyFHIRImportJob AND n.status = 'in_progress')
          OR (n:CyFHIRImportCheckpoint AND n.status = 'in_progress')
       RETURN DISTINCT n.source AS source`
    );
    return result.records.map(record => record.get('source')).filter(Boolean);
  } finally {
    await session.close();
  }
}

const activeImportJobs = new Map<string, Promise<any>>();

async function verifyConnection() {
  const d = getDriver();
  try {
    await d.verifyConnectivity();
    console.log('Verified Neo4j Connection');
  } catch (error) {
    console.log(`Connectivity Verification Failed: ${error}`);
  }
}

function startTransaction(cypher: string, res) {
  try {
    const d = getDriver();
    const session: Session = d.session();

    session.writeTransaction(tx => tx.run(cypher))
      .then(result => {
        return res({ result });
      })
      .catch(error => {
        console.log(error);
        return res({ error });
      })
      .finally(() => {
        session.close();
      });
  } catch (error) {
    console.log(error);
    return res({ error });
  }
}
// }1. Nhận vào một chuỗi Cypher
// 2. Mở kết nối Neo4j
// 3. Tạo transaction ghi
// 4. Chạy câu Cypher bằng tx.run(cypher)
// 5. Nếu thành công, đóng session và driver
// 6. Trả result
// 7. Nếu lỗi, trả error

function loadBundleNeo4j(_bundle, res: Response) {
  startTransaction(cypher.loadBundle(_bundle), (result) => {
    if (result) {
      return res.status(200).send(result);
    } else {
      return res.status(500).send({
        error: 'Error'
      });
    }
  });
}

function loadBundleNeo4jPromise(_bundle: any): Promise<any> {
  return new Promise((resolve, reject) => {
    startTransaction(cypher.loadBundle(_bundle), (result: any) => {
      if (result && result.result) {
        resolve(result.result);
      } else {
        reject(new Error(result?.error?.message || 'Error loading bundle'));
      }
    });
  });
}

function deleteAllNodes(req: Request, res: Response) {
  startTransaction(cypher.deleteAll(), (result) => {
    if (result && result.result !== undefined) {
      return res.status(200).send('All nodes deleted');
    } else {
      return res.status(500).send(result?.error || 'Error');
    }
  });
}

function getBundle(_id: string, res: Response) {
  startTransaction(cypher.buildBundleAroundID(_id), (result) => {
    if (result.result) {
      const bundle = result.result.records[0]._fields[0];
      if (Object.keys(bundle).length === 0) {
        return res.status(400).send({
          message: `Entry with ID ${_id} not found`
        });
      }
      return res.status(200).send(bundle);
    } else {
      return res.status(500).send(result.error);
    }
  });
}

function getBundleWithFilter(_id: string, _filter: string, res: Response) {
  startTransaction(cypher.buildBundleAroundIDWithFilter(_id, _filter), (result) => {
    if (result.result) {
      const bundle = result.result.records[0]._fields[0];
      if (Object.keys(bundle).length === 0) {
        return res.status(400).send({
          message: `Entry with ID ${_id} not found`
        });
      }
      return res.status(200).send(bundle);
    } else {
      return res.status(500).send(result.error);
    }
  });
}

function loadResourceNeo4j(_resource, res: Response) {
  startTransaction(cypher.loadResource(_resource), (result) => {
    if (result) {
      return res.status(200).send(result);
    } else {
      return res.status(500).send({
        error: 'Error'
      });
    }
  });
}

function getResource(_id: string, res: Response) {
  startTransaction(cypher.getResource(_id), (result) => {
    if (result.result) {
      const resource = result.result.records[0]._fields[0];
      if (Object.keys(resource).length === 0) {
        return res.status(400).send({
          message: `Resource with ID ${_id} not found`
        });
      }
      return res.status(200).send(resource);
    } else {
      return res.status(500).send(result.error);
    }
  });
}

// Strip large binary data from entries before loading
function sanitizeEntry(entry: any): any {
  if (!entry?.resource) return entry;
  const r = entry.resource;
  // Strip binary data from all resources
  if (r.data !== undefined) {
    r.data = undefined;
  }
  // Strip text.div (generated HTML) from all resources
  if (r.text?.div !== undefined) {
    r.text.div = undefined;
  }
  // DocumentReference: strip attachment data
  if (r.resourceType === 'DocumentReference' && r.content) {
    r.content = r.content.map((c: any) => {
      if (c.attachment && c.attachment.data !== undefined) {
        c.attachment.data = undefined;
      }
      return c;
    });
  }
  return entry;
}

async function loadFromFhirServer(_params: any, res: Response) {
  const fhirBaseUrl = _params.fhirBaseUrl || process.env.FHIR_SERVER_URL || '';
  if (!fhirBaseUrl) {
    return res.status(400).send({ error: 'fhirBaseUrl is required but was not provided and FHIR_SERVER_URL env is not set' });
  }
  const resourceType = _params.resourceType;
  const searchParams = _params.searchParams || '';

  if (!resourceType) {
    return res.status(400).send({ error: 'resourceType is required' });
  }

  // Use smaller page size for large resources
  const largeResources = ['Binary', 'DocumentReference', 'Observation', 'Claim', 'ClaimResponse'];
  const pageSize = largeResources.indexOf(resourceType) >= 0 ? '100' : '500';

  try {
    let url = `${fhirBaseUrl}/${resourceType}${searchParams ? '?' + searchParams : `?_count=${pageSize}`}`;
    let pageNum = 0;

    while (url) {
      pageNum++;
      console.log(`Fetching page ${pageNum} for ${resourceType}: ${url.substring(0, 120)}...`);

      const response = await fetch(url);
      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).send({
          error: `Failed to fetch from FHIR server: ${response.status} ${response.statusText}`,
          detail: errText
        });
      }

      const bundle = await response.json();
      if (bundle.resourceType !== 'Bundle') {
        return res.status(400).send({ error: 'Response is not a FHIR Bundle' });
      }

      if (bundle.entry) {
        const sanitized = bundle.entry.map((e: any) => sanitizeEntry(e));
        const pageBundle = {
          resourceType: 'Bundle',
          type: 'collection',
          total: sanitized.length,
          entry: sanitized
        };
        await loadBundleNeo4jPromise(pageBundle);
      }

      // Rewrite next link URL to use external address instead of internal Docker name
      const nextLink = bundle.link?.find((l: any) => l.relation === 'next');
      url = nextLink
        ? nextLink.url
            .replace('http://hapi-fhir:8080/fhir', fhirBaseUrl)
            .replace('http://172.16.12.230:8014/fhir', fhirBaseUrl)
        : null;
    }

    return res.status(200).send({ message: `Done loading ${resourceType}` });
  } catch (error: any) {
    console.error('loadFromFhirServer error:', error);
    return res.status(500).send({
      error: 'Failed to load from FHIR server',
      detail: error.message
    });
  }
}

export = {
  loadBundle: (bundle, res: Response) => {
    return loadBundleNeo4j(bundle, res);
  },
  deleteAll: (req: Request, res: Response) => {
    return deleteAllNodes(req, res);
  },
  buildBundle: (_id: string, _filter: string, res: Response) => {
    if (_filter && Object.keys(_filter).length > 0) {
      return getBundleWithFilter(_id, _filter, res);
    } else {
      return getBundle(_id, res);
    }
  },
  loadResource: (resource, res: Response) => {
    return loadResourceNeo4j(resource, res);
  },
  getFhirResource: (_id: string, res: Response) => {
      return getResource(_id, res);
  },
  verifyConnection: () => {
    return verifyConnection();
  },
  resumePendingImports: () => {
    return resumePendingImports();
  },
  loadFromFhirServer: (params: any, res: Response) => {
    return loadFromFhirServer(params, res);
  },
  loadAllResources: (params: any, res: Response) => {
    return loadAllResources(params, res);
  },
  closeDriver: () => {
    if (driver) {
      return driver.close();
    }
  }
};

async function runLoadAllResources(_params: any) {
  const rawFhirUrl = _params.fhirBaseUrl || process.env.FHIR_SERVER_URL || '';
  if (!rawFhirUrl) {
    throw new Error('fhirBaseUrl is required but was not provided and FHIR_SERVER_URL env is not set');
  }
  const fhirBaseUrl = normalizeFhirBaseUrl(rawFhirUrl);

  // List of resource types from Neo4j
  const resourceTypes = [


    // 'Binary',
    // 'ValueSet',
    'StructureDefinition',
    'CodeSystem',
    // 'NamingSystem',

    'Library',
    'PlanDefinition',
    'ActivityDefinition',


    'Patient',

    'Organization',
    'Location',

    'Practitioner',
    'PractitionerRole',

    'Medication',

    'Encounter',
    'ServiceRequest',
    'Procedure',

    'Observation',
    'DiagnosticReport',

    'Condition',

    'Composition',

    'Coverage',
    'Claim',
    'ExplanationOfBenefit',

    'MedicationRequest',
    'MedicationStatement',


     ];

  const largeResourceTypes = new Set(['Binary', 'ValueSet', 'CodeSystem', 'StructureDefinition', 'Library', 'NamingSystem']);

  // Strip large binary data before loading to avoid oversized bundles
  function sanitizeEntry(entry: any): any {
    if (!entry?.resource) return entry;
    const r = entry.resource;
    // Strip binary data from all resources
    if (r.data !== undefined) {
      r.data = undefined;
    }
    // Strip text.div (generated HTML) from all resources
    if (r.text?.div !== undefined) {
      r.text.div = undefined;
    }
    // DocumentReference: strip attachment data
    if (r.resourceType === 'DocumentReference' && r.content) {
      r.content = r.content.map((c: any) => {
        if (c.attachment && c.attachment.data !== undefined) {
          c.attachment.data = undefined;
        }
        return c;
      });
    }
    return entry;
  }

  const results: any[] = [];

  // Set resetCheckpoint=true only when a complete re-import is intentionally needed.
  if (_params.resetCheckpoint === true) {
    await clearImportCheckpoints(fhirBaseUrl);
    console.log(`Cleared import checkpoints for ${fhirBaseUrl}`);
  }

  for (const resourceType of resourceTypes) {
    try {
      const checkpoint = await getImportCheckpoint(fhirBaseUrl, resourceType);
      if (checkpoint?.status === 'completed') {
        results.push({ resourceType, loaded: checkpoint.totalLoaded, skipped: true, resumed: true });
        console.log(`Skipping ${resourceType}: already completed (${checkpoint.totalLoaded} loaded)`);
        continue;
      }

      let totalLoaded = checkpoint?.totalLoaded || 0;
      const pageSize = largeResourceTypes.has(resourceType) ? '100' : '500';
      let url = checkpoint?.nextUrl || `${fhirBaseUrl}/${resourceType}?_count=${pageSize}`;
      let pageNum = checkpoint?.pageNum || 0;

      if (checkpoint) {
        console.log(`Resuming ${resourceType} at page ${pageNum + 1} (${totalLoaded} resources already loaded)`);
      }

      while (url) {
        pageNum++;
        console.log(`Loading ${resourceType} page ${pageNum}...`);

        const response = await fetch(url);
        if (!response.ok) {
          console.error(`Failed to fetch ${resourceType} page ${pageNum}: ${response.status}`);
          throw new Error(`FHIR server returned ${response.status} for page ${pageNum}`);
        }

        const bundle = await response.json();
        if (bundle.entry?.length) {
          // Sanitize entries (strip large binary data)
          const sanitized = bundle.entry.map((e: any) => sanitizeEntry(e));
          const pageBundle = {
            resourceType: 'Bundle',
            type: 'collection',
            total: sanitized.length,
            entry: sanitized
          };
          await loadBundleNeo4jPromise(pageBundle);
          totalLoaded += sanitized.length;
        }

        // Commit the page before advancing its checkpoint. If Docker stops in
        // between, at most this one page is submitted again on the next run.
        const nextLink = bundle.link?.find((l: any) => l.relation === 'next');
        const nextUrl = nextLink ? rewriteNextUrl(nextLink.url, fhirBaseUrl) : null;
        await saveImportCheckpoint(fhirBaseUrl, resourceType, {
          nextUrl,
          pageNum,
          totalLoaded,
          status: nextUrl ? 'in_progress' : 'completed'
        });
        url = nextUrl;
      }

      if (totalLoaded > 0) {
        results.push({ resourceType, loaded: totalLoaded });
        console.log(`Done: ${totalLoaded} ${resourceType} loaded`);
      } else {
        results.push({ resourceType, loaded: 0, skipped: true });
      }
    } catch (error: any) {
      console.error(`Error loading ${resourceType}:`, error.message);
      results.push({ resourceType, error: error.message });
    }
  }

  const totalAll = results.reduce((sum, r) => sum + (r.loaded || 0), 0);
  return {
    message: `Loaded ${totalAll} resources across ${results.filter((r: any) => r.loaded > 0).length} resource types`,
    results
  };
}

function startLoadAllResources(params: any): { source: string; started: boolean } {
  const rawUrl = params.fhirBaseUrl || process.env.FHIR_SERVER_URL || '';
  if (!rawUrl) {
    throw new Error('fhirBaseUrl is required but was not provided and FHIR_SERVER_URL env is not set');
  }
  const source = normalizeFhirBaseUrl(rawUrl);
  if (activeImportJobs.has(source)) {
    return { source, started: false };
  }

  const job = (async () => {
    await setImportJobStatus(source, 'in_progress');
    try {
      const result = await runLoadAllResources({ ...params, fhirBaseUrl: source });
      const failed = result.results.filter((item: any) => item.error);
      if (failed.length > 0) {
        await setImportJobStatus(source, 'in_progress', failed.map((item: any) => item.resourceType).join(', '));
        console.error(`FHIR import paused for ${source}; failed resource types: ${failed.map((item: any) => item.resourceType).join(', ')}`);
      } else {
        await setImportJobStatus(source, 'completed');
        console.log(`FHIR import completed for ${source}: ${result.message}`);
      }
      return result;
    } catch (error: any) {
      await setImportJobStatus(source, 'in_progress', error.message);
      console.error(`FHIR import interrupted for ${source}:`, error.message);
      return { error: error.message };
    } finally {
      activeImportJobs.delete(source);
    }
  })();

  activeImportJobs.set(source, job);
  return { source, started: true };
}

function loadAllResources(params: any, res: Response) {
  const job = startLoadAllResources(params || {});
  return res.status(202).send({
    message: job.started ? 'FHIR import started in background' : 'FHIR import is already running',
    source: job.source,
    started: job.started
  });
}

async function resumePendingImports(): Promise<void> {
  const sources = await getPendingImportSources();
  for (const source of sources) {
    const job = startLoadAllResources({ fhirBaseUrl: source });
    if (job.started) {
      console.log(`Resuming interrupted FHIR import for ${source}`);
    }
  }
}
