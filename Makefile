UUID = cricket-score@krushnaj.github.io
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP = $(UUID).shell-extension.zip

.PHONY: install uninstall compile-schemas pack clean

compile-schemas:
	glib-compile-schemas schemas/

# Zip for https://extensions.gnome.org/upload/ — files at zip root only
pack: compile-schemas
	rm -f $(ZIP)
	gnome-extensions pack --force \
		--extra-source=icons \
		--extra-source=LICENSE
	@echo "Created $(ZIP)"
	@echo "Upload at https://extensions.gnome.org/upload/"

install: compile-schemas
	mkdir -p $(EXTENSION_DIR)
	cp -f metadata.json extension.js stylesheet.css prefs.js LICENSE $(EXTENSION_DIR)/
	mkdir -p $(EXTENSION_DIR)/schemas $(EXTENSION_DIR)/icons
	cp -f schemas/*.xml schemas/gschemas.compiled $(EXTENSION_DIR)/schemas/
	cp -f icons/*.svg $(EXTENSION_DIR)/icons/
	@echo "Installed to $(EXTENSION_DIR)"
	@echo "Restart GNOME Shell, then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(EXTENSION_DIR)
	@echo "Removed $(EXTENSION_DIR)"

clean:
	rm -f $(ZIP)
