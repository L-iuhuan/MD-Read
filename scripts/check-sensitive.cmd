@echo off
rem scripts/check-sensitive.cmd -- thin wrapper for the sensitive-info gate (no network, no deps).
rem
rem Why it exists: this machine has only Windows PowerShell 5.1 (no pwsh), and the default
rem execution policy (RemoteSigned) refuses to run unsigned .ps1 files. The wrapper pins the
rem two required switches (-NoProfile -ExecutionPolicy Bypass) so `scripts\check-sensitive.cmd`
rem works from cmd, PowerShell and CI alike.
rem
rem NOTE: keep this file ASCII-only -- cmd.exe reads it in the OEM code page, so non-ASCII
rem comments would be mangled and leak garbage tokens as commands.
rem
rem Exit code is passed through (0 = pass; 1 = hits; other = the script itself failed to run).
rem CI can test %ERRORLEVEL% directly.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-sensitive.ps1" %*
exit /b %ERRORLEVEL%
