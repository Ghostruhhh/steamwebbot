Seller: usual setup is TWO files:

  A) Web buyers first get GalaxyLoader.exe (bootstrap) — often your built pkg at dist\GalaxyLoader.exe
    
     In .env: LOADER_BOOTSTRAP_EXE_PATH=dist\GalaxyLoader.exe
      
  B) The real product after they run GalaxyLoader and enter the key again:
  
     Put your installer .exe in this folder (or elsewhere) and set:

       LOADER_ARTIFACT_PATH=artifacts/MyProductInstaller.exe

     or absolute, e.g. LOADER_ARTIFACT_PATH=C:\\Builds\\MyProductInstaller.exe

Optional download names → LOADER_CLIENT_DOWNLOAD_FILENAME=GalaxyLoader.exe and LOADER_DOWNLOAD_FILENAME=MyProduct-Installer.exe

Restart npm start. Browser /loader/ sends delivery:web → bootstrap when LOADER_BOOTSTRAP_EXE_PATH is set; CLI / GalaxyLoader.exe uses native activate → product installer.

Until paths point at REAL files:
• Keys still ACTIVATE (license ↔ device), but the matching download step shows “not configured”.
• Drop any harmless .exe to smoke-test each path end-to-end.

This folder intentionally has no exe in Git — binaries are yours to add.
