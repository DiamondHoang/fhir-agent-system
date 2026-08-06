import asyncio
import os
import sys
from pathlib import Path

# Add backend to sys.path
sys.path.append(str(Path(__file__).parent.parent / "backend"))

from app.skin_diagnostic.session_store import SkinDiagnosticStore, SkinDiagnosticRun

async def test_neo4j_patient_id_persistence():
    store = SkinDiagnosticStore()

    # We need to make sure we are using the correct DATA_DIR
    # The session_store.py uses: DATA_DIR = Path(__file__).resolve().parent / "data"
    # Since this script is in backend/scripts/, DATA_DIR is backend/app/skin_diagnostic/data

    run_id = "test-run-123"
    user_id = "test-user"
    neo4j_id = "neo4j-patient-abc"

    print(f"Creating run with neo4j_patient_id: {neo4j_id}")

    run = await store.create(
        user_id=user_id,
        image_path="test_image.jpg",
        image_url="http://test.com/test_image.jpg",
        anamnesis="Test anamnesis",
        run_id=run_id,
        neo4j_patient_id=neo4j_id
    )

    print(f"Run created. ID: {run.id}, Neo4j ID: {run.neo4j_patient_id}")

    # Check if it's in memory
    retrieved = await store.get(run_id, user_id=user_id)
    if retrieved and retrieved.neo4j_patient_id == neo4j_id:
        print("✅ Success: Found correct neo4j_patient_id in memory.")
    else:
        print("❌ Failure: neo4j_patient_id mismatch in memory.")
        print(f"Retrieved: {retrieved.neo4j_patient_id if retrieved else 'None'}")
        return

    # Simulate reload from disk
    # Note: SkinDiagnosticStore.load_from_disk() clears the current _runs dict?
    # Looking at the code:
    #     async def load_from_disk(self) -> int:
    #         loaded = 0
    #         async with self._lock:
    #             for path in SESSIONS_DIR.glob("*.json"):
    #                 ...
    #                 self._runs[run.id] = run

    # It doesn't clear it, it just adds.
    # Let's create a NEW store instance to force a disk load.

    new_store = SkinDiagnosticStore()
    loaded_count = await new_store.load_from_disk()
    print(f"Loaded {loaded_count} runs from disk.")

    retrieved_from_disk = await new_store.get(run_id, user_id=user_id)
    if retrieved_from_disk and retrieved_from_disk.neo4j_patient_id == neo4j_id:
        print("✅ Success: Found correct neo4j_patient_id from disk.")
    else:
        print("❌ Failure: neo4j_patient_id mismatch on disk load.")
        print(f"Retrieved: {retrieved_from_disk.neo4j_patient_id if retrieved_from_disk else 'None'}")
        return

    print("All tests passed!")

if __name__ == "__main__":
    asyncio.run(test_neo4j_patient_id_persistence())
