UUID := spatial-overview@cleomenezesjr.github.io
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := extension.js metadata.json stylesheet.css prefs.js
SCHEMA_DIR := schemas
SCHEMA_FILE := $(SCHEMA_DIR)/org.gnome.shell.extensions.spatial-overview.gschema.xml
SCHEMA_COMPILED := $(SCHEMA_DIR)/gschemas.compiled

.PHONY: install uninstall enable disable lint

$(SCHEMA_COMPILED): $(SCHEMA_FILE)
	glib-compile-schemas --strict $(SCHEMA_DIR)

install: $(SCHEMA_COMPILED) $(FILES)
	mkdir -p "$(DEST)/$(SCHEMA_DIR)"
	cp $(FILES) "$(DEST)"
	cp $(SCHEMA_COMPILED) "$(DEST)/$(SCHEMA_DIR)"
	@echo "Installed to $(DEST)"
	@echo "Run 'make enable' to activate."

uninstall:
	rm -rf "$(DEST)"
	@echo "Uninstalled."

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

lint:
	@tmp=$$(mktemp -d) && cp $(FILES) "$$tmp" && cp -r $(SCHEMA_DIR) "$$tmp/$(SCHEMA_DIR)" && \
		rm -f "$$tmp/$(SCHEMA_DIR)/gschemas.compiled" && \
		shexli "$$tmp"; \
		rc=$$?; rm -rf "$$tmp"; exit $$rc
	npx eslint .
