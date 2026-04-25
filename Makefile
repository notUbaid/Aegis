# Aegis — common dev commands
# Run `make` with no args to see the target list.

.DEFAULT_GOAL := help
.PHONY: help setup dev emulators stop install install-shared lint test \
        ingest vision orchestrator dispatch clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: ## First-time setup (install Python deps via uv)
	@echo ">> Installing uv if not present"
	@command -v uv >/dev/null 2>&1 || pip install uv
	@echo ">> Installing shared library"
	@cd services/shared && uv pip install -e .
	@echo ">> Installing each service"
	@for svc in ingest vision orchestrator dispatch; do \
		echo ">> services/$$svc"; \
		cd services/$$svc && uv pip install -e . && cd ../..; \
	done

install-shared: ## Install the shared library in editable mode
	cd services/shared && uv pip install -e .

install: install-shared ## Install all service deps
	@for svc in ingest vision orchestrator dispatch; do \
		echo ">> services/$$svc"; \
		cd services/$$svc && uv pip install -e . && cd ../..; \
	done

emulators: ## Start Firestore + Pub/Sub emulators in docker
	docker compose up -d firestore-emulator pubsub-emulator
	@echo ">> Firestore: http://127.0.0.1:8080"
	@echo ">> Pub/Sub:   http://127.0.0.1:8085"

dev: emulators ## Start all services locally (emulators + Python services)
	@echo ">> Starting services (ctrl-c to stop)"
	@scripts/dev.sh

stop: ## Stop emulators + any running containers
	docker compose down

ingest: ## Run ingest service locally
	cd services/ingest && uvicorn main:app --reload --port 8001

vision: ## Run vision service locally
	cd services/vision && uvicorn main:app --reload --port 8002

orchestrator: ## Run orchestrator service locally
	cd services/orchestrator && uvicorn main:app --reload --port 8003

dispatch: ## Run dispatch service locally
	cd services/dispatch && uvicorn main:app --reload --port 8004

lint: ## Run ruff + mypy across all Python code
	ruff check .
	ruff format --check .
	mypy services agents

fmt: ## Auto-format everything
	ruff format .
	ruff check --fix .

test: ## Run pytest across all services
	pytest services/ -v

clean: ## Remove caches and build artifacts
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .mypy_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .ruff_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name '*.egg-info' -exec rm -rf {} + 2>/dev/null || true
