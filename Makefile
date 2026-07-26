UUID := spatial-overview@cleomenezesjr.github.io
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := extension.js metadata.json stylesheet.css

.PHONY: install uninstall enable disable lint

install: $(FILES)
	mkdir -p "$(DEST)"
	cp $(FILES) "$(DEST)"
	@echo "Installed to $(DEST)"
	@echo "Run 'make enable' or restart GNOME Shell to activate."

uninstall:
	rm -rf "$(DEST)"
	@echo "Uninstalled."

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

lint:
	shexli .
	npx eslint .
