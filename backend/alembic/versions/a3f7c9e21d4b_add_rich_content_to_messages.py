"""add rich content (image_url, structured_data) to messages

Revision ID: a3f7c9e21d4b
Revises: 6f8d4b2a9c13
Create Date: 2026-08-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "a3f7c9e21d4b"
down_revision: Union[str, Sequence[str], None] = "6f8d4b2a9c13"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("message_type", sa.String(length=30), server_default="text", nullable=False),
    )
    op.add_column(
        "messages",
        sa.Column("image_url", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("structured_data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "structured_data")
    op.drop_column("messages", "image_url")
    op.drop_column("messages", "message_type")
