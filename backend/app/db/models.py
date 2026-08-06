from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    username: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
        unique=True,
        index=True,
    )

    password_hash: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )

    external_id: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        unique=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    conversations: Mapped[list["Conversation"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    title: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    summary: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="",
    )

    summary_through_message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )

    summary_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    memory_version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )

    # HAPI FHIR Patient (luong A — "benh nhan moi") this conversation's
    # skin-diagnostic photo is linked to. Column added by migration
    # f1a2b3c4d5e6; set in app/skin_diagnostic/router.py. NOTE: this field
    # was previously mis-mapped as `patient_id` (no matching migration ever
    # existed for that name), which meant every assignment to
    # `conversation.fhir_patient_id` in router.py silently failed to persist
    # (SQLAlchemy just set an untracked plain attribute). Fixed here to
    # match the actual DB column from f1a2b3c4d5e6.
    fhir_patient_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )

    # Neo4j Patient (FHIRResource:Patient) this conversation's skin-diagnostic
    # photos belong to (see app/skin_images/*, luong B — "benh nhan dang co").
    # Set once the doctor picks an existing patient for an uploaded photo;
    # nullable because most conversations aren't about a photographed
    # patient at all. Column added by migration <neo4j_patient_id revision>.
    neo4j_patient_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )

    user: Mapped["User"] = relationship(
        back_populates="conversations",
    )

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
        foreign_keys="Message.conversation_id",
    )


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(
            "role IN ('user', 'assistant', 'system')",
            name="ck_messages_role",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    role: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    content: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )

    # Everything below was added so a page reload no longer loses what a
    # message actually looked like. Before this, only the plain-text
    # `content` survived a reload — an attached photo and the structured
    # dermatology result (ranked diagnoses, badges, etc.) only ever lived in
    # the browser's in-memory React state, so refreshing silently dropped
    # both and left a bare paragraph of text behind.
    message_type: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        server_default="text",
    )

    image_url: Mapped[str | None] = mapped_column(
        String(500),
        nullable=True,
    )

    structured_data: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    conversation: Mapped["Conversation"] = relationship(
        back_populates="messages",
        foreign_keys=[conversation_id],
    )