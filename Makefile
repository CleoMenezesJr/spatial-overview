UUID := spatial-workspace@cleomenezesjr.github.io
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := extension.js metadata.json stylesheet.css

.PHONY: install uninstall reload enable disable lint

install: $(FILES)
	mkdir -p "$(DEST)"
	cp $(FILES) "$(DEST)"
	@echo "Installed to $(DEST)"
	@echo "Run 'make enable' or restart GNOME Shell to activate."

uninstall:
	rm -rf "$(DEST)"
	@echo "Uninstalled."

reload: install
	@echo "Restarting GNOME Shell (X11: Alt+F2 → r | Wayland: log out and back in)"
	@dbus-send --session --type=method_call \
		--dest=org.gnome.Shell /org/gnome/Shell \
		org.gnome.Shell.Eval string:'Meta.restart("Restarting GNOME Shell…")' 2>/dev/null \
		|| echo "Could not restart. Log out and back in."

enable:
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

lint:
	npx eslint .
