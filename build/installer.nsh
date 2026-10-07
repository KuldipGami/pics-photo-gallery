; Included by electron-builder (build/installer.nsh).
; Uninstalling Lumen removes what its settings may have added for the current user:
; "Scan with Lumen" in the folder right-click menu and "Start with Windows".
; An update runs the old uninstaller too, so these are kept then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Lumen"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Lumen"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.lumen.gallery"
  ${endIf}
!macroend
