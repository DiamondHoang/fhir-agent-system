# Makefile for FHIR Agent System

.PHONY: up down restart logs ps clean seed

up:
	docker compose up --build -d

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

ps:
	docker compose ps

seed:
	docker compose run --rm cyfhir-seed

clean:
	docker compose down -v
