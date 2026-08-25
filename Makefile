.PHONY: dev \
       build \
       build-mac build-win build-linux \
       lint format typecheck check test test-e2e test-coverage \
       install start clean help

help:
	@echo "Chaterm Makefile Commands:"
	@echo ""
	@echo "  Development:"
	@echo "    make install          - Install dependencies"
	@echo "    make dev              - Start dev server"
	@echo "    make start            - Preview production build"
	@echo ""
	@echo "  Build:"
	@echo "    make build            - Build renderer/main bundles"
	@echo "    make build-mac        - Build macOS package (dmg/zip)"
	@echo "    make build-win        - Build Windows package (NSIS)"
	@echo "    make build-linux      - Build Linux package (AppImage/deb)"
	@echo ""
	@echo "  Code Quality:"
	@echo "    make lint             - Run ESLint with auto-fix"
	@echo "    make format           - Run Prettier"
	@echo "    make typecheck        - Run TypeScript type checking"
	@echo "    make check            - Run lint + format + typecheck"
	@echo ""
	@echo "  Testing:"
	@echo "    make test             - Run unit tests"
	@echo "    make test-e2e         - Run E2E tests"
	@echo "    make test-coverage    - Run tests with coverage"

install:
	node scripts/patch-package-lock.js
	npm install

dev:
	npm run dev

start:
	npm run start

build:
	npm run build

build-mac:
	npm run build:mac

build-win:
	npm run build:win

build-linux:
	npm run build:linux

lint:
	npm run lint

format:
	npm run format

typecheck:
	npm run typecheck

check: lint format typecheck

test:
	npm test

test-e2e:
	npm run test:e2e

test-coverage:
	npm run test:coverage

clean:
	rm -rf out dist node_modules/.vite
