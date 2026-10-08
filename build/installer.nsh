; Included by electron-builder (build/installer.nsh).
; Uninstalling Pics removes what its settings may have added for the current user:
; "Scan with Pics" in the folder right-click menu and "Start with Windows" (and the same entries
; from when it was called Lumen). An update runs the old uninstaller too, so these are kept then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Pics"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Pics"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Lumen"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Lumen"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.lumen.gallery"
  ${endIf}
!macroend
