# wudict-hover — build, package, sign and release for Chrome and Firefox.
#
# Compatible with GNU Make 3.81 (macOS stock): no .ONESHELL, no $(file ...).
# Secrets are never make variables — recipes read them from the environment or .env
# shell-side, so `make -p` and the build log cannot leak them.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --warn-undefined-variables --no-builtin-rules
.DEFAULT_GOAL := help
.DELETE_ON_ERROR:
.SUFFIXES:

# ---------------------------------------------------------------- configuration

NAME      := wudict-hover
VERSION   := $(shell cat VERSION)
SRC       := src
DIST      := dist
ART       := $(DIST)/artifacts
TEST      := test

# Development server used by `make check-server`. Matches the extension default.
BASE_URL  ?= http://127.0.0.1:6888

# Firefox: AMO channel for `make sign-firefox`. `unlisted` self-distributes a
# signed xpi; `listed` submits for public review (see `publish-firefox`).
AMO_CHANNEL ?= unlisted

# Chrome: local CRX signing key, and the Web Store item to publish to.
CRX_KEY      ?= chrome-key.pem
CWS_ITEM_ID  ?=

# Persistent dev profiles: a throwaway profile would discard the Firefox host
# permission grant (and any Chrome state) on every launch.
PROFILE_DIR      ?= .profiles
CHROMIUM_PROFILE ?= $(PROFILE_DIR)/chromium
FIREFOX_PROFILE  ?= $(PROFILE_DIR)/firefox

NODE_BIN  := node_modules/.bin
WEB_EXT   := $(NODE_BIN)/web-ext
ESLINT    := $(NODE_BIN)/eslint
PRETTIER  := $(NODE_BIN)/prettier
DEPS_STAMP := node_modules/.install-stamp

CHROME_BIN ?= $(shell /bin/bash -c 'for c in \
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
	"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
	"/Applications/Chromium.app/Contents/MacOS/Chromium" \
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
	"$$(command -v google-chrome 2>/dev/null || true)" \
	"$$(command -v chromium 2>/dev/null || true)"; do \
	if [ -n "$$c" ] && [ -x "$$c" ]; then echo "$$c"; exit 0; fi; done')

# Everything under src/ is copied verbatim except the per-flavour manifests, which
# are assembled and version-stamped instead.
SOURCES := $(shell find $(SRC) -type f ! -name 'manifest.*.json' ! -name '.DS_Store')

# MV3 content scripts cannot be ES modules, so these are concatenated into one
# classic script at build time. Order is dependency order — see tools/bundle-content.mjs.
CONTENT_SOURCES := \
	$(SRC)/common/api.js \
	$(SRC)/common/protocol.js \
	$(SRC)/common/settings.js \
	$(SRC)/common/state.js \
	$(SRC)/common/refs.js \
	$(SRC)/content/words.js \
	$(SRC)/content/caret.js \
	$(SRC)/content/sanitize.js \
	$(SRC)/content/popup.js \
	$(SRC)/content/main.js

# Toolbar icons are generated, not checked in: Chrome will not accept an SVG in
# `icons`, and eight hand-exported PNGs in two tints is exactly the kind of asset
# that goes stale. See tools/make-icons.mjs.
ICON_STATES := on off
ICON_SIZES  := 16 32 48 128
ICONS := $(foreach state,$(ICON_STATES),$(foreach size,$(ICON_SIZES),\
	$(SRC)/icons/$(state)-$(size).png))

CHROME_DIR  := $(DIST)/chrome
FIREFOX_DIR := $(DIST)/firefox
CHROME_ZIP  := $(ART)/$(NAME)-$(VERSION)-chrome.zip
FIREFOX_ZIP := $(ART)/$(NAME)-$(VERSION)-firefox.zip
CRX         := $(ART)/$(NAME)-$(VERSION).crx

# Load .env into the recipe's own shell only. `if/fi` rather than `&&` so that a
# missing .env is not a failure under `set -e`.
LOAD_ENV := if [ -f .env ]; then set -a; . ./.env; set +a; fi

# ------------------------------------------------------------------------- help

.PHONY: help
help: ## Show this help
	@echo "$(NAME) v$(VERSION) — targets:"
	@echo
	@awk 'BEGIN {FS = ":.*?## "} \
		/^# -+ [a-z]/ { sub(/^# -+ /, ""); pending = $$0; next } \
		/^[a-zA-Z0-9_-]+:.*?## / { \
			if (pending != "") { printf "\n  \033[1m%s\033[0m\n", pending; pending = "" } \
			printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@echo
	@echo "  Common flow:  make preflight deps build validate package"
	@echo

# ------------------------------------------------------------------ preconditions

.PHONY: preflight
preflight: ## Check that required and optional tooling is present
	@fail=0; \
	for t in node npm jq zip tar curl shasum; do \
		if command -v $$t >/dev/null 2>&1; then \
			printf '  \033[32mok\033[0m       %s\n' "$$t"; \
		else \
			printf '  \033[31mMISSING\033[0m  %s (required)\n' "$$t"; fail=1; \
		fi; \
	done; \
	if node -e 'process.exit(parseInt(process.versions.node,10) >= 18 ? 0 : 1)' 2>/dev/null; then \
		printf '  \033[32mok\033[0m       node %s (>= 18)\n' "$$(node --version)"; \
	else \
		printf '  \033[31mMISSING\033[0m  node >= 18 (have %s)\n' "$$(node --version 2>/dev/null || echo none)"; fail=1; \
	fi; \
	if command -v openssl >/dev/null 2>&1; then \
		printf '  \033[32mok\033[0m       openssl (needed only by `make crx-key`)\n'; \
	else \
		printf '  \033[33mabsent\033[0m   openssl — `make crx-key` will not work\n'; \
	fi; \
	if [ -x "$(WEB_EXT)" ]; then \
		printf '  \033[32mok\033[0m       web-ext\n'; \
	else \
		printf '  \033[33mabsent\033[0m   web-ext — run `make deps` (needed by run/lint/sign)\n'; \
	fi; \
	if [ -n "$(CHROME_BIN)" ]; then \
		printf '  \033[32mok\033[0m       chrome: %s\n' "$(CHROME_BIN)"; \
	else \
		printf '  \033[33mabsent\033[0m   chrome/chromium not found — set CHROME_BIN=/path/to/chrome\n'; \
	fi; \
	exit $$fail

.PHONY: check-server
check-server: ## Verify a wudict server is reachable at BASE_URL
	@code=$$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$(BASE_URL)/api/dicts" || echo 000); \
	if [ "$$code" = "200" ]; then \
		ct=$$(curl -s -m 5 -o /dev/null -D - "$(BASE_URL)/api/dicts" | tr -d '\r' \
			| sed -n 's/^[Cc]ontent-[Tt]ype: *//p'); \
		n=$$(curl -s -m 20 "$(BASE_URL)/api/dicts" | grep -c '"t":"dict"' || true); \
		printf '  \033[32mok\033[0m  %s — %s dictionaries, content-type %s\n' "$(BASE_URL)" "$$n" "$$ct"; \
	else \
		printf '  \033[31mfail\033[0m  %s/api/dicts returned %s\n' "$(BASE_URL)" "$$code"; \
		echo '        Start wudict, or pass BASE_URL=http://host:port'; \
		exit 1; \
	fi

# --------------------------------------------------------------------- lifecycle

.PHONY: deps
deps: $(DEPS_STAMP) ## Install dev dependencies (web-ext, eslint, prettier)

$(DEPS_STAMP): package.json
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi
	@mkdir -p $(dir $@) && touch $@

.PHONY: clean
clean: ## Remove build output
	@rm -rf $(DIST)
	@echo "  removed $(DIST)/"

.PHONY: distclean
distclean: clean ## Remove build output and dev dependencies
	@rm -rf node_modules
	@echo "  removed node_modules/"

# ------------------------------------------------------------------------- build

$(ART):
	@mkdir -p $@

# One rule per flavour via a pattern: the tree is copied minus the flavour
# manifests, then manifest.<flavour>.json is stamped with VERSION as manifest.json.
# The output dir is removed first so a deleted source file cannot linger in dist.
$(ICONS): tools/make-icons.mjs
	@node tools/make-icons.mjs $(SRC)/icons

.PHONY: icons
icons: $(ICONS) ## Regenerate the toolbar icon set

$(DIST)/%/.build-stamp: $(SOURCES) $(ICONS) $(SRC)/manifest.%.json VERSION tools/bundle-content.mjs
	@rm -rf $(DIST)/$*
	@mkdir -p $(DIST)/$*
	@tar -cf - -C $(SRC) --exclude='manifest.*.json' --exclude='.DS_Store' \
		--exclude='./content' --exclude='./content/*' . | tar -xf - -C $(DIST)/$*
	@node tools/bundle-content.mjs $(DIST)/$*/content.js $(CONTENT_SOURCES)
	@node --check $(DIST)/$*/content.js
	@jq --arg v '$(VERSION)' '.version = $$v' $(SRC)/manifest.$*.json > $(DIST)/$*/manifest.json
	@touch $@
	@echo "  built $(DIST)/$* (v$(VERSION))"

.PHONY: build build-chrome build-firefox
build-chrome: $(CHROME_DIR)/.build-stamp ## Build the unpacked Chrome extension
build-firefox: $(FIREFOX_DIR)/.build-stamp ## Build the unpacked Firefox extension
build: build-chrome build-firefox ## Build both flavours

# ----------------------------------------------------------------------- quality

.PHONY: lint
lint: ## Run eslint over src/ (skipped if eslint is not installed)
	@if [ -x "$(ESLINT)" ]; then $(ESLINT) $(SRC) $(TEST) tools; \
	else echo "  eslint not installed — run 'make deps' (skipping)"; fi

.PHONY: format
format: ## Format src/ with prettier (skipped if prettier is not installed)
	@if [ -x "$(PRETTIER)" ]; then \
		$(PRETTIER) --write '$(SRC)/**/*.{js,css,json}' '$(TEST)/**/*.js' 'eslint.config.js'; \
	else echo "  prettier not installed — run 'make deps' (skipping)"; fi

.PHONY: format-check
format-check: ## Fail if the tree is not prettier-clean
	@if [ -x "$(PRETTIER)" ]; then \
		$(PRETTIER) --check '$(SRC)/**/*.{js,css,json}' '$(TEST)/**/*.js' 'eslint.config.js'; \
	else echo "  prettier not installed — run 'make deps' (skipping)"; fi

.PHONY: test
test: ## Run unit tests (node:test)
	@if [ -d $(TEST) ] && compgen -G "$(TEST)/*.test.js" >/dev/null; then \
		node --test "$(TEST)/**/*.test.js"; \
	else echo "  no tests in $(TEST)/ yet (skipping)"; fi

.PHONY: validate validate-chrome validate-firefox
validate-chrome: build-chrome ## Sanity-check the built Chrome manifest
	@jq -e '.manifest_version == 3' $(CHROME_DIR)/manifest.json >/dev/null \
		|| { echo "  manifest_version must be 3"; exit 1; }
	@jq -e --arg v '$(VERSION)' '.version == $$v' $(CHROME_DIR)/manifest.json >/dev/null \
		|| { echo "  version not stamped to $(VERSION)"; exit 1; }
	@jq -e '.background.service_worker' $(CHROME_DIR)/manifest.json >/dev/null \
		|| { echo "  Chrome MV3 needs background.service_worker"; exit 1; }
	@jq -e '(.key | type) == "string" and (.key | length) > 300' $(CHROME_DIR)/manifest.json >/dev/null \
		|| { echo "  manifest.key missing — the unpacked extension id would drift per install"; exit 1; }
	@jq -e 'has("host_permissions") | not' $(CHROME_DIR)/manifest.json >/dev/null \
		|| { echo "  host_permissions must stay absent (D69: no loopback URL reaches the page)"; exit 1; }
	@jq -e '.permissions | index("offscreen")' $(CHROME_DIR)/manifest.json >/dev/null \
		|| { echo "  the offscreen permission is what keeps audio out of the page"; exit 1; }
	@node tools/check-imports.mjs $(CHROME_DIR)
	@echo "  chrome manifest ok"

# web-ext lint is Firefox's own validator, so it is the authority for that flavour
# only — it (correctly) rejects Chrome's service_worker key.
validate-firefox: build-firefox ## Validate the Firefox build with web-ext lint
	@jq -e '.background.scripts' $(FIREFOX_DIR)/manifest.json >/dev/null \
		|| { echo "  Firefox MV3 needs background.scripts, not service_worker"; exit 1; }
	@jq -e '.browser_specific_settings.gecko.id' $(FIREFOX_DIR)/manifest.json >/dev/null \
		|| { echo "  browser_specific_settings.gecko.id is required for signing"; exit 1; }
	@jq -e 'has("host_permissions") | not' $(FIREFOX_DIR)/manifest.json >/dev/null \
		|| { echo "  host_permissions must stay absent (D69: no loopback URL reaches the page)"; exit 1; }
	@node tools/check-imports.mjs $(FIREFOX_DIR)
	@if [ -x "$(WEB_EXT)" ]; then $(WEB_EXT) lint --source-dir $(FIREFOX_DIR) --self-hosted; \
	else echo "  web-ext not installed — run 'make deps' (skipping lint)"; fi
	@echo "  firefox manifest ok"

validate: validate-chrome validate-firefox ## Validate both builds

.PHONY: check
check: preflight lint test validate ## Everything a CI run should do

# --------------------------------------------------------------------------- run

.PHONY: run-chrome
run-chrome: build-chrome ## Launch Chrome with the extension loaded (persistent profile)
	@if [ ! -x "$(WEB_EXT)" ]; then echo "  need web-ext: make deps"; exit 1; fi
	@if [ -z "$(CHROME_BIN)" ]; then echo "  no chrome found; set CHROME_BIN=/path/to/chrome"; exit 1; fi
	@mkdir -p $(PROFILE_DIR)
	$(WEB_EXT) run --target chromium --source-dir $(CHROME_DIR) \
		--chromium-binary "$(CHROME_BIN)" \
		--chromium-profile "$(CHROMIUM_PROFILE)" --profile-create-if-missing

# --firefox-profile runs a *copy* of the profile unless --keep-profile-changes is
# given, and without it the granted host permission is discarded on every launch —
# which matters because Firefox MV3 makes that grant a manual step.
.PHONY: run-firefox
run-firefox: build-firefox ## Launch Firefox with the extension loaded (persistent profile)
	@if [ ! -x "$(WEB_EXT)" ]; then echo "  need web-ext: make deps"; exit 1; fi
	@mkdir -p $(PROFILE_DIR)
	$(WEB_EXT) run --source-dir $(FIREFOX_DIR) --browser-console \
		--firefox-profile "$(FIREFOX_PROFILE)" --profile-create-if-missing \
		--keep-profile-changes

.PHONY: clean-profiles
clean-profiles: ## Delete the persistent browser profiles (drops permission grants)
	@rm -rf $(PROFILE_DIR)
	@echo "  removed $(PROFILE_DIR)/"

# web-ext reloads when its source dir changes, but its source dir is dist/, not
# src/ — so this rebuilds dist/ on change. Pair it with `make run-<flavour>` in a
# second terminal.
.PHONY: watch-chrome watch-firefox
watch-chrome: ## Rebuild the Chrome flavour whenever src/ changes
	@$(MAKE) --no-print-directory _watch FLAVOUR=chrome
watch-firefox: ## Rebuild the Firefox flavour whenever src/ changes
	@$(MAKE) --no-print-directory _watch FLAVOUR=firefox

.PHONY: _watch
_watch:
	@echo "  watching $(SRC)/ -> $(DIST)/$(FLAVOUR)  (ctrl-c to stop)"
	@if command -v fswatch >/dev/null 2>&1; then \
		$(MAKE) --no-print-directory build-$(FLAVOUR); \
		fswatch -o $(SRC) VERSION | while read -r _; do \
			$(MAKE) --no-print-directory build-$(FLAVOUR) || true; done; \
	else \
		echo "  (fswatch not found — polling every 2s; brew install fswatch for instant rebuilds)"; \
		while true; do $(MAKE) --no-print-directory build-$(FLAVOUR) || true; sleep 2; done; \
	fi

# ----------------------------------------------------------------------- package

$(CHROME_ZIP): $(CHROME_DIR)/.build-stamp | $(ART)
	@rm -f $@
	@cd $(CHROME_DIR) && zip -qr -X "$(abspath $(CHROME_ZIP))" . -x '.build-stamp'
	@echo "  packaged $@ ($$(du -h $@ | cut -f1))"

$(FIREFOX_ZIP): $(FIREFOX_DIR)/.build-stamp | $(ART)
	@rm -f $@
	@cd $(FIREFOX_DIR) && zip -qr -X "$(abspath $(FIREFOX_ZIP))" . -x '.build-stamp'
	@echo "  packaged $@ ($$(du -h $@ | cut -f1))"

.PHONY: package package-chrome package-firefox
package-chrome: $(CHROME_ZIP) ## Zip the Chrome build (Web Store upload format)
package-firefox: $(FIREFOX_ZIP) ## Zip the Firefox build (AMO upload format)
package: package-chrome package-firefox ## Zip both flavours

.PHONY: checksums
checksums: package ## Write SHA-256 sums for every artifact
	@cd $(ART) && find . -maxdepth 1 -type f \( -name '*.zip' -o -name '*.crx' \) \
		| sort | xargs shasum -a 256 > SHA256SUMS
	@cat $(ART)/SHA256SUMS

# -------------------------------------------------------------------------- sign

.PHONY: crx-key
crx-key: ## Generate the local CRX signing key (once; keep it out of git)
	@if [ -f $(CRX_KEY) ]; then echo "  $(CRX_KEY) already exists — refusing to overwrite"; exit 1; fi
	@openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $(CRX_KEY) 2>/dev/null
	@chmod 600 $(CRX_KEY)
	@echo "  wrote $(CRX_KEY) (gitignored — back it up, the extension ID derives from it)"

.PHONY: crx-chrome
crx-chrome: build-chrome | $(ART) ## Pack a signed .crx for self-distribution
	@if [ -z "$(CHROME_BIN)" ]; then echo "  no chrome found; set CHROME_BIN=/path/to/chrome"; exit 1; fi
	@if [ ! -f $(CRX_KEY) ]; then echo "  no $(CRX_KEY) — run 'make crx-key' first"; exit 1; fi
	@"$(CHROME_BIN)" --pack-extension="$(abspath $(CHROME_DIR))" \
		--pack-extension-key="$(abspath $(CRX_KEY))" --no-message-box
	@mv $(DIST)/chrome.crx $(CRX)
	@echo "  signed $(CRX)"

# web-ext picks the credentials up from WEB_EXT_API_KEY / WEB_EXT_API_SECRET itself,
# so they never appear on a command line or in the log.
.PHONY: sign-firefox
sign-firefox: build-firefox | $(ART) ## Sign the Firefox build via AMO (unlisted by default)
	@if [ ! -x "$(WEB_EXT)" ]; then echo "  need web-ext: make deps"; exit 1; fi
	@$(LOAD_ENV); \
	if [ -z "$${WEB_EXT_API_KEY:-}" ] || [ -z "$${WEB_EXT_API_SECRET:-}" ]; then \
		echo "  AMO credentials missing."; \
		echo "  Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (env or .env) from"; \
		echo "  https://addons.mozilla.org/developers/addon/api/key/"; \
		exit 1; \
	fi; \
	$(WEB_EXT) sign --source-dir $(FIREFOX_DIR) --artifacts-dir $(ART) \
		--channel $(AMO_CHANNEL)

.PHONY: publish-firefox
publish-firefox: ## Submit to AMO for public listing (CONFIRM=yes required)
	@if [ "$${CONFIRM:-}" != "yes" ]; then \
		echo "  publish-firefox submits v$(VERSION) publicly to AMO and cannot be undone."; \
		echo "  Re-run as: make publish-firefox CONFIRM=yes"; \
		exit 1; \
	fi
	@$(MAKE) --no-print-directory sign-firefox AMO_CHANNEL=listed

.PHONY: publish-chrome
publish-chrome: ## Upload and publish to the Chrome Web Store (CONFIRM=yes required)
	@if [ "$${CONFIRM:-}" != "yes" ]; then \
		echo "  publish-chrome uploads and publishes v$(VERSION) to the Chrome Web Store."; \
		echo "  Re-run as: make publish-chrome CONFIRM=yes"; \
		exit 1; \
	fi
	@if [ -z "$(CWS_ITEM_ID)" ]; then echo "  set CWS_ITEM_ID=<extension id>"; exit 1; fi
	@$(MAKE) --no-print-directory package-chrome
	@$(LOAD_ENV); \
	if [ -z "$${CWS_CLIENT_ID:-}" ] || [ -z "$${CWS_CLIENT_SECRET:-}" ] || [ -z "$${CWS_REFRESH_TOKEN:-}" ]; then \
		echo "  Chrome Web Store credentials missing."; \
		echo "  Set CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (env or .env)."; \
		exit 1; \
	fi; \
	token=$$(curl -s -X POST https://oauth2.googleapis.com/token \
		-d "client_id=$$CWS_CLIENT_ID" -d "client_secret=$$CWS_CLIENT_SECRET" \
		-d "refresh_token=$$CWS_REFRESH_TOKEN" -d 'grant_type=refresh_token' \
		| jq -r '.access_token // empty'); \
	if [ -z "$$token" ]; then echo "  OAuth token exchange failed"; exit 1; fi; \
	echo "  uploading $(CHROME_ZIP) to item $(CWS_ITEM_ID)"; \
	up=$$(curl -s -H "Authorization: Bearer $$token" -H 'x-goog-api-version: 2' \
		-X PUT -T "$(CHROME_ZIP)" \
		"https://www.googleapis.com/upload/chromewebstore/v1.1/items/$(CWS_ITEM_ID)"); \
	state=$$(echo "$$up" | jq -r '.uploadState // "FAILURE"'); \
	if [ "$$state" != "SUCCESS" ]; then echo "  upload failed: $$up"; exit 1; fi; \
	echo "  publishing"; \
	pub=$$(curl -s -H "Authorization: Bearer $$token" -H 'x-goog-api-version: 2' \
		-H 'Content-Length: 0' -X POST \
		"https://www.googleapis.com/chromewebstore/v1.1/items/$(CWS_ITEM_ID)/publish"); \
	echo "$$pub" | jq -r '.status[]? // "published"'

# ----------------------------------------------------------------------- release

.PHONY: version
version: ## Print the current version
	@echo $(VERSION)

.PHONY: bump-patch bump-minor bump-major
bump-patch: ## Increment the patch version
	@$(MAKE) --no-print-directory _bump PART=patch
bump-minor: ## Increment the minor version
	@$(MAKE) --no-print-directory _bump PART=minor
bump-major: ## Increment the major version
	@$(MAKE) --no-print-directory _bump PART=major

.PHONY: _bump
_bump:
	@awk -F. -v part='$(PART)' '{ \
		if (part == "major") { $$1++; $$2 = 0; $$3 = 0 } \
		else if (part == "minor") { $$2++; $$3 = 0 } \
		else { $$3++ } \
		printf "%d.%d.%d\n", $$1, $$2, $$3 }' VERSION > VERSION.tmp
	@mv VERSION.tmp VERSION
	@echo "  version $(VERSION) -> $$(cat VERSION)"

.PHONY: tag
tag: ## Create an annotated git tag for the current version
	@if [ -n "$$(git status --porcelain)" ]; then echo "  working tree is dirty — commit first"; exit 1; fi
	@if git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null; then \
		echo "  tag v$(VERSION) already exists"; exit 1; fi
	@git tag -a "v$(VERSION)" -m "$(NAME) v$(VERSION)"
	@echo "  tagged v$(VERSION) (push with: git push origin v$(VERSION))"

# Deliberately stops at signed-nothing: signing and publishing need credentials and
# are separate, explicit steps.
.PHONY: release
release: clean check package checksums ## Full local release build (does not publish)
	@echo
	@echo "  release candidate v$(VERSION) in $(ART)/"
	@echo "  next: make sign-firefox           (signed xpi, self-hosted)"
	@echo "        make crx-chrome             (signed crx, self-hosted)"
	@echo "        make publish-firefox CONFIRM=yes"
	@echo "        make publish-chrome CONFIRM=yes CWS_ITEM_ID=..."

.PHONY: addlicense
addlicense: ## Scan and add missing licenses
	addlicense -l agpl -s=only -l agpl -v -ignore "node_modules/**" .
