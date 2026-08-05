"""add fhir_patient_id to conversations

Revision ID: f1a2b3c4d5e6
Revises: a3f7c9e21d4b
Create Date: 2026-08-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "a3f7c9e21d4b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("fhir_patient_id", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversations", "fhir_patient_id")