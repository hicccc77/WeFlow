{
  description = "WeFlow for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = pkg: pkg.pname == "weflow";
      };
      inherit (pkgs) lib;
      electron = pkgs.electron;
      packageJson = builtins.fromJSON (builtins.readFile "${self}/package.json");
      runtimeLibraries = with pkgs; [
        alsa-lib
        at-spi2-atk
        atk
        cups
        dbus
        libdrm
        libGL
        libnotify
        libsecret
        libxkbcommon
        mesa
        nspr
        nss
        pango
        stdenv.cc.cc.lib
        wayland
        libx11
        libxcomposite
        libxdamage
        libxext
        libxfixes
        libxrandr
        libxrender
        libxtst
        libxcb
        libxshmfence
      ];
    in
    {
      packages.${system}.default = pkgs.buildNpmPackage {
        pname = "weflow";
        version = packageJson.version;
        src = self;
        npmDepsHash = "sha256-KT5XcDdS5l+6DP2oolBJO10XX+6cg2pgPFOMAHJrjv4=";
        npmFlags = [ "--legacy-peer-deps" ];
        npmInstallFlags = [ "--legacy-peer-deps" ];
        npmRebuildFlags = [ "--ignore-scripts" ];
        nativeBuildInputs = [
          pkgs.makeWrapper
          pkgs.wrapGAppsHook3
        ];
        buildInputs = with pkgs; [
          electron
          ffmpeg
          gsettings-desktop-schemas
          glib
          gtk3
          gtk4
        ];
        dontWrapGApps = true;
        env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        dontNpmBuild = true;

        buildPhase = ''
          runHook preBuild
          npm run typecheck
          node scripts/clean-dist-electron.cjs
          npx vite build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          npm prune --omit=dev --ignore-scripts --offline --legacy-peer-deps

          appDir="$out/lib/weflow/app"
          runtimeDir="$out/lib/weflow/runtime"
          mkdir -p "$appDir" "$runtimeDir/resources/resources" "$runtimeDir/resources/assets/wasm"
          cp -a dist dist-electron "$appDir/"
          cp package.json "$appDir/"
          cp -a node_modules "$appDir/"
          cp -a resources/. "$runtimeDir/resources/resources/"
          cp -a electron/assets/wasm/. "$runtimeDir/resources/assets/wasm/"
          cp public/icon.png "$runtimeDir/icon.png"
          cp public/icon.ico "$runtimeDir/icon.ico"

          cp -a ${electron.unwrapped}/libexec/electron/. "$runtimeDir/"
          chmod u+w "$runtimeDir/resources"
          cp public/icon.png "$runtimeDir/resources/icon.png"
          ln -s ${pkgs.ffmpeg}/bin/ffmpeg "$appDir/node_modules/ffmpeg-static/ffmpeg"
          mkdir -p "$runtimeDir/resources/app.asar.unpacked"
          ln -s "$appDir/node_modules" "$runtimeDir/resources/app.asar.unpacked/node_modules"

          gappsWrapperArgsHook
          makeWrapper "$runtimeDir/electron" "$out/bin/weflow" \
            "''${gappsWrapperArgs[@]}" \
            --add-flags "\''${WAYLAND_DISPLAY:+--ozone-platform=wayland --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}" \
            --add-flags "$appDir" \
            --set ELECTRON_FORCE_IS_PACKAGED 1 \
            --set AUTO_UPDATE_ENABLED 0 \
            --set CHROME_DEVEL_SANDBOX "$runtimeDir/chrome-sandbox" \
            --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath runtimeLibraries}" \
            --inherit-argv0

          install -Dm644 public/icon.png "$out/share/icons/hicolor/512x512/apps/weflow.png"
          mkdir -p "$out/share/applications"
          cat > "$out/share/applications/weflow.desktop" <<EOF
          [Desktop Entry]
          Type=Application
          Name=WeFlow
          Comment=Local chat history viewer and analysis tool
          Exec=$out/bin/weflow %U
          Icon=weflow
          Categories=Utility;
          Terminal=false
          EOF

          runHook postInstall
        '';

        meta = {
          description = "Local chat history viewer, analysis and export tool";
          homepage = "https://github.com/hicccc77/WeFlow";
          license = lib.licenses.cc-by-nc-sa-40;
          platforms = [ system ];
          mainProgram = "weflow";
        };
      };
    };
}
