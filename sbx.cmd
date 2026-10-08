@echo off
rem Convenience runner: injects the BotConnector API key from BCCLI integrations
rem and forwards all arguments to the Switchboard CLI.
setlocal EnableDelayedExpansion
if "%BOTCONNECTOR_API_KEY%"=="" (
  set "KEYFILE=%USERPROFILE%\.bccli\integrations\bc-cloud.key"
  if exist "!KEYFILE!" (
    set /p BOTCONNECTOR_API_KEY=<"!KEYFILE!"
  )
)
if "%BOTCONNECTOR_API_KEY%"=="" (
  echo [sbx] BOTCONNECTOR_API_KEY is not set and no key file was found. 1>&2
  exit /b 1
)
node "%~dp0dist\cli.js" %*
