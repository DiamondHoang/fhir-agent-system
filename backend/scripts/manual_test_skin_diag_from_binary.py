import asyncio
import uuid
from pathlib import Path
import sys

# Add backend to sys.path
sys.path.append(str(Path(__file__).parent.parent))

from app.core.config import settings
from app.skin_diagnostic.session_store import get_store
from app.skin_diagnostic.service import start_skin_diagnostic_from_binary
from neo4j import AsyncGraphDatabase

async def find_test_data():
    """Find a binary_id and patient_id from Neo4j."""
    driver = AsyncGraphDatabase.driver(
        settings.neo4j_uri,
        auth=(settings.neo4j_username, settings.neo4j_password)
    )
    async with driver:
        # Find a Binary that is linked to a Patient
        query = """
        MATCH (p:Patient)-[:HAS_BINARY]->(b:Binary)
        RETURN p.id AS patient_id, b.id AS binary_id, b.content_type AS content_type
        LIMIT 1
        """
        result = await driver.execute_query(query)
        if not result.records:
            raise ValueError("No test Binary/Patient data found in Neo4j. Please seed Synthea data.")

        record = result.records[0]
        return str(record["patient_id"]), str(record["binary_id"])

async def main():
    print("🔍 Searching for test data in Neo4j...")
    try:
        patient_id, binary_id = await find_test_data()
        print(f"✅ Found test data: Patient={patient_id}, Binary={binary_id}")
    except Exception as e:
        print(f"❌ Error finding test data: {e}")
        return

    user_id = str(uuid.uuid4())
    conversation_id = str(uuid.uuid4())
    initial_complaint = "Tôi bị một vết đỏ trên da, nó ngứa lắm."

    print(f"🚀 Starting skin diagnostic for patient {patient_id} with binary {binary_id}...")

    try:
        run = await start_skin_diagnostic_from_binary(
            user_id=user_id,
            conversation_id=conversation_id,
            patient_id=patient_id,
            binary_id=binary_id,
            initial_complaint=initial_complaint
        )
        print(f"✅ Run started! Run ID: {run.id}")
        print(f"Current status: {run.status}, Step: {run.current_step}")

        # Poll the session store for completion
        store = await get_store()
        print("⏳ Waiting for pipeline to complete (this may take a while)...")

        max_retries = 60  # 5 minutes if polling every 5s
        for i in range(max_retries):
            await asyncio.sleep(5)
            retrieved_run = await store.get(run.id, user_id=user_id)

            if not retrieved_run:
                print("❌ Error: Run disappeared from store!")
                break

            print(f"[{i+1}/{max_retries}] Status: {retrieved_run.status}, Step: {retrieved_run.current_step}")

            if retrieved_run.status in ["completed", "interrupt", "failed"]:
                print(f"🏁 Pipeline finished with status: {retrieved_run.status}")
                if retrieved_run.error:
                    print(f"⚠️ Error: {retrieved_run.error}")

                if retrieved_run.status == "completed":
                    print("🎉 Success! The diagnostic was completed.")
                return

        print("❌ Timeout: Pipeline did not finish in time.")

    except Exception as e:
        print(f"❌ Error during test: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
