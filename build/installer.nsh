; March3D custom NSIS hooks
; electron-builder inserts these macros into the generated Windows installer.

!macro customInstall
  ; $APPDATA is the current user's %APPDATA% folder (AppData\Roaming).
  ; Make sure OpenMarch's plugin directory exists, then install/update the
  ; March3D sync plugin alongside the desktop application.
  CreateDirectory "$APPDATA\OpenMarch\plugins"
  CopyFiles /SILENT "$INSTDIR\resources\openmarch-plugin\March3DSync.om.js" "$APPDATA\OpenMarch\plugins\March3DSync.om.js"
!macroend

!macro customUnInstall
  ; Remove the plugin installed by March3D when March3D itself is uninstalled.
  Delete "$APPDATA\OpenMarch\plugins\March3DSync.om.js"
!macroend
