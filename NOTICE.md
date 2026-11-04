# Reference and implementation notes

The user supplied `visual-stagram-code-master.zip` (Visual Stagram Code, package author `hongje`) as the reference for an editor-style chat app. Its source was inspected to understand the mirrored-chat architecture. This implementation is newly written and does not bundle that project's Instagram scraper, renderer, bridge, extension, icons or assets. The supplied archive did not include an explicit license file.

Version 0.2 uses a local editor UI that mirrors rendered Discord DOM. Account credentials remain in the original Discord web page. The adapter does not access tokens, internal modules, stores or account APIs. It reads the rendered conversation, and manual user submissions are forwarded to Discord's original composer through native text/key input. There are no automatic messages, bulk sends or background reply features.

Electron and electron-builder are used for the application, and jsdom for tests. Dependency licenses are retained with installed packages and relevant Electron runtime notices in the packaged application.

Discord and Visual Studio Code are associated with their respective owners. This project is unofficial and not affiliated with Discord or Microsoft.
