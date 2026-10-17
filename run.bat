@echo off
REM Blackjack App - Windows Batch Runner
REM Usage: run.bat [command]
REM Commands: install, dev, build, preview, test, typecheck, lint, clean

set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=help"

echo.
echo ========================================
echo   BLACKJACK 21 - App Runner
echo ========================================
echo.

if /I "%COMMAND%"=="help" (
    echo Available commands:
    echo   install     - Install npm dependencies
    echo   dev         - Start development server
    echo   build       - Type-check and build for production
    echo   preview     - Preview production build locally
    echo   test        - Run tests once
    echo   test:watch  - Run tests in watch mode
    echo   test:ui     - Run tests with UI
    echo   typecheck   - Run TypeScript type checking
    echo   lint        - Run ESLint
    echo   clean       - Remove node_modules and dist
    echo   all         - Install, typecheck, lint, test, build
    echo.
    echo Example: run.bat dev
    goto :eof
)

if /I "%COMMAND%"=="install" (
    echo Installing dependencies...
    npm install
    goto :eof
)

if /I "%COMMAND%"=="dev" (
    echo Starting development server...
    npm run dev
    goto :eof
)

if /I "%COMMAND%"=="build" (
    echo Building for production...
    npm run build
    goto :eof
)

if /I "%COMMAND%"=="preview" (
    echo Previewing production build...
    npm run preview
    goto :eof
)

if /I "%COMMAND%"=="test" (
    echo Running tests...
    npm run test
    goto :eof
)

if /I "%COMMAND%"=="test:watch" (
    echo Running tests in watch mode...
    npm run test:watch
    goto :eof
)

if /I "%COMMAND%"=="test:ui" (
    echo Running tests with UI...
    npm run test:ui
    goto :eof
)

if /I "%COMMAND%"=="typecheck" (
    echo Running TypeScript type check...
    npm run typecheck
    goto :eof
)

if /I "%COMMAND%"=="lint" (
    echo Running ESLint...
    npm run lint
    goto :eof
)

if /I "%COMMAND%"=="clean" (
    echo Cleaning node_modules and dist...
    if exist node_modules rmdir /s /q node_modules
    if exist dist rmdir /s /q dist
    echo Clean complete.
    goto :eof
)

if /I "%COMMAND%"=="all" (
    echo Running full pipeline: install, typecheck, lint, test, build...
    call %0 install
    if errorlevel 1 exit /b 1
    call %0 typecheck
    if errorlevel 1 exit /b 1
    call %0 lint
    if errorlevel 1 exit /b 1
    call %0 test
    if errorlevel 1 exit /b 1
    call %0 build
    echo.
    echo ========================================
    echo   All checks passed!
    echo ========================================
    goto :eof
)

echo Unknown command: %COMMAND%
echo Run "run.bat help" for available commands.
exit /b 1