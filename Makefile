.PHONY: dev dev-cn dev-global \
       build build-cn build-global \
       build-mac-cn build-mac-global build-win-cn build-win-global build-linux-cn build-linux-global \
       lint format typecheck check test test-e2e test-coverage \
       install start clean help

help:
	@echo "Chaterm Makefile Commands:"
	@echo ""
	@echo "  Development:"
	@echo "    make install          - Install dependencies"
	@echo "    make dev              - Start dev server (CN edition)"
	@echo "    make dev-global       - Start dev server (Global edition)"
	@echo "    make start            - Preview production build"
	@echo ""
	@echo "  Build:"
	@echo "    make build            - Build (CN edition)"
	@echo "    make build-global     - Build (Global edition)"
	@echo "    make build-mac-cn     - Build macOS package (CN)"
	@echo "    make build-mac-global - Build macOS package (Global)"
	@echo "    make build-win-cn     - Build Windows package (CN)"
	@echo "    make build-win-global - Build Windows package (Global)"
	@echo "    make build-linux-cn   - Build Linux package (CN)"
	@echo "    make build-linux-global - Build Linux package (Global)"
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

dev-global:
	npm run dev:global

start:
	npm run start

build:
	npm run build:cn

build-global:
	npm run build:global

build-mac-cn:
	npm run build:mac:cn

build-mac-global:
	npm run build:mac:global

build-win-cn:
	npm run build:win:cn

build-win-global:
	npm run build:win:global

build-linux-cn:
	npm run build:linux:cn

build-linux-global:
	npm run build:linux:global

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
