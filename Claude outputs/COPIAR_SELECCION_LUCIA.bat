@echo off
setlocal enabledelayedexpansion
set "LP=("
set "RP=)"
echo ================================================
echo     COPIADOR DE SELECCION - LUCIA
echo ================================================
echo.

set /p "ORIGEN=Pega la ruta de la carpeta con las fotos: "
set "PREFIJO=LUCIA"
set "DESTINO=%USERPROFILE%\Desktop\SELECCION_LUCIA"
if not exist "%DESTINO%" mkdir "%DESTINO%"

echo.
echo Origen:  %ORIGEN%
echo Prefijo: %PREFIJO%
echo Destino: %DESTINO%
echo.
echo Copiando fotos seleccionadas...
echo.

set COUNT=0
set MISSING=0

set "TMPFILE=%TEMP%\numeros_tmp_%RANDOM%.txt"
(
  echo 22
  echo 50
  echo 69
  echo 74
  echo 79
  echo 93
  echo 94
  echo 128
  echo 214
  echo 250
  echo 253
  echo 281
  echo 340
  echo 345
  echo 351
  echo 353
  echo 381
  echo 403
  echo 419
  echo 420
  echo 424
  echo 429
  echo 441
  echo 447
  echo 451
) > "!TMPFILE!"

for /f "usebackq tokens=* delims=" %%N in ("!TMPFILE!") do (
  set "RAW=%%N"
  set "RAW=!RAW: =!"
  set "FOUND=0"

  if not "!RAW!"=="" (
    rem Saca los ceros a la izquierda como texto (NO con "set /a": cmd
    rem interpreta cualquier numero que arranca con 0 como octal, y
    rem numeros con 8 o 9 -como 069 u 097- tiran error directamente, mientras
    rem que otros -como 023- se leen mal en silencio y copian el archivo
    rem equivocado sin avisar). Se repite la resta de un cero varias veces
    rem en vez de usar un loop con goto, que dentro de un bloque for /f
    rem entre parentesis es poco confiable en cmd.exe.
    set "INTNUM=!RAW!"
    if "!INTNUM:~0,1!"=="0" if not "!INTNUM!"=="0" set "INTNUM=!INTNUM:~1!"
    if "!INTNUM:~0,1!"=="0" if not "!INTNUM!"=="0" set "INTNUM=!INTNUM:~1!"
    if "!INTNUM:~0,1!"=="0" if not "!INTNUM!"=="0" set "INTNUM=!INTNUM:~1!"
    if "!INTNUM:~0,1!"=="0" if not "!INTNUM!"=="0" set "INTNUM=!INTNUM:~1!"

    if exist "%ORIGEN%\%PREFIJO%-!RAW!.jpg" (
      copy "%ORIGEN%\%PREFIJO%-!RAW!.jpg" "%DESTINO%\%PREFIJO%-!RAW!.jpg" >nul
      echo   [OK] %PREFIJO%-!RAW!.jpg
      set /a COUNT+=1
      set "FOUND=1"
    )

    rem Algunas carpetas nombran las fotos con el numero entre parentesis
    rem en vez de con guion adelante. Se prueban ambos formatos, con y sin
    rem ceros a la izquierda, antes de darla por no encontrada. Los
    rem parentesis se arman con variables (LP y RP) en vez de escribirlos
    rem literal aca adentro, porque un parentesis suelto dentro de un
    rem bloque if rompe la sintaxis del .bat en Windows.
    if "!FOUND!"=="0" (
      if exist "%ORIGEN%\%PREFIJO% !LP!!RAW!!RP!.jpg" (
        copy "%ORIGEN%\%PREFIJO% !LP!!RAW!!RP!.jpg" "%DESTINO%\%PREFIJO% !LP!!RAW!!RP!.jpg" >nul
        echo   [OK] %PREFIJO% !LP!!RAW!!RP!.jpg
        set /a COUNT+=1
        set "FOUND=1"
      )
    )

    if "!FOUND!"=="0" (
      if exist "%ORIGEN%\%PREFIJO%-!INTNUM!.jpg" (
        copy "%ORIGEN%\%PREFIJO%-!INTNUM!.jpg" "%DESTINO%\%PREFIJO%-!INTNUM!.jpg" >nul
        echo   [OK] %PREFIJO%-!INTNUM!.jpg
        set /a COUNT+=1
        set "FOUND=1"
      )
    )

    if "!FOUND!"=="0" (
      if exist "%ORIGEN%\%PREFIJO% !LP!!INTNUM!!RP!.jpg" (
        copy "%ORIGEN%\%PREFIJO% !LP!!INTNUM!!RP!.jpg" "%DESTINO%\%PREFIJO% !LP!!INTNUM!!RP!.jpg" >nul
        echo   [OK] %PREFIJO% !LP!!INTNUM!!RP!.jpg
        set /a COUNT+=1
        set "FOUND=1"
      )
    )

    rem Si no aparecio con el prefijo exacto, se busca solo por numero,
    rem con cualquier prefijo adelante. Pasa cuando el nombre real del
    rem archivo tiene tildes o enies -por ej. LUCIA con tilde en la I-,
    rem que la app saca del prefijo y que el .bat no puede escribir bien.
    if "!FOUND!"=="0" (
      for %%F in ("%ORIGEN%\*-!RAW!.jpg" "%ORIGEN%\* !LP!!RAW!!RP!.jpg") do (
        copy "%%~fF" "%DESTINO%\%%~nxF" >nul
        echo   [OK] %%~nxF
        set /a COUNT+=1
        set "FOUND=1"
      )
    )

    if "!FOUND!"=="0" (
      for %%F in ("%ORIGEN%\*-!INTNUM!.jpg" "%ORIGEN%\* !LP!!INTNUM!!RP!.jpg") do (
        copy "%%~fF" "%DESTINO%\%%~nxF" >nul
        echo   [OK] %%~nxF
        set /a COUNT+=1
        set "FOUND=1"
      )
    )

    if "!FOUND!"=="0" (
      echo   [X] NO ENCONTRADA: foto numero !RAW!
      set /a MISSING+=1
    )
  )
)

if exist "!TMPFILE!" del "!TMPFILE!"

echo.
echo ================================================
echo  Fotos copiadas:  !COUNT!
echo  No encontradas:  !MISSING!
echo  Carpeta destino: %DESTINO%
echo ================================================
echo.
pause
endlocal