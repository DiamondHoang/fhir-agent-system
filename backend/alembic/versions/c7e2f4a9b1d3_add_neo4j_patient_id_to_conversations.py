"""add neo4j_patient_id to conversations

Revision ID: c7e2f4a9b1d3
Revises: f1a2b3c4d5e6
Create Date: 2026-08-05 00:00:00.000001

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c7e2f4a9b1d3"
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Neo4j Patient (FHIRResource:Patient) id — luong B ("benh nhan dang co")
    # from the fhir-agent -> fhir-agent-system skin image integration.
    # Kept as a separate column from fhir_patient_id (HAPI FHIR server,
    # luong A "benh nhan moi") since the two are independent id spaces that
    # must never be confused with each other.
    op.add_column(
        "conversations",
        sa.Column("neo4j_patient_id", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversations", "neo4j_patient_id")
