@echo off
setlocal
echo ================================================
echo     COPIADOR DE SELECCION - WANDA
echo ================================================
echo.
set "ORIGEN="
set /p "ORIGEN=Pega la ruta de la carpeta con las fotos: "
echo.
if not defined ORIGEN goto sinruta
set "PREFIJO=WANDA"
set "NUMEROS=9 10 12 15 32 54 57 75 79 97 146 180 197 218 229 241 258 259 275 288 294 300 335 338 341 352 363 373 380 383"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:PREFIJO; $o=$env:ORIGEN.Trim().Trim([char]34).Trim(); $d=Join-Path ([Environment]::GetFolderPath('Desktop')) ('SELECCION_'+$p); Write-Host ('Origen:  '+$o); Write-Host ('Destino: '+$d); Write-Host ''; if(-not (Test-Path -LiteralPath $o -PathType Container)){ Write-Host ('  [X] No existe la carpeta: '+$o); Write-Host '      Revisa la ruta: tiene que ser la carpeta donde estan las fotos.'; exit }; $fotos=@(Get-ChildItem -LiteralPath $o -File | Where-Object { $_.Extension -in '.jpg','.jpeg','.png' }); if($fotos.Count -eq 0){ Write-Host '  [X] No hay fotos JPG o PNG en esa carpeta. Esto es lo que tiene:'; Get-ChildItem -LiteralPath $o | Select-Object -First 8 | ForEach-Object { Write-Host ('      '+$_.Name) }; exit }; New-Item -ItemType Directory -Force -Path $d | Out-Null; $idx=@{}; foreach($f in $fotos){ if($f.BaseName -match '([0-9]+)[^0-9]*$'){ $k=[decimal]$matches[1]; if(-not $idx.ContainsKey($k)){ $idx[$k]=@() }; $idx[$k]+=$f } }; $ok=0; $miss=0; foreach($t in ($env:NUMEROS -split ' ')){ if($t -eq ''){ continue }; $n=[decimal]$t; if($idx.ContainsKey($n)){ $f=@($idx[$n] | Sort-Object { -not $_.BaseName.ToUpper().StartsWith($p) }, Name)[0]; Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $d $f.Name) -Force; Write-Host ('  [OK] '+$f.Name); $ok++ } else { Write-Host ('  [X] NO ENCONTRADA: foto numero '+$t); $miss++ } }; Write-Host ''; Write-Host '================================================'; Write-Host ('  Fotos copiadas:  '+$ok); Write-Host ('  No encontradas:  '+$miss); Write-Host ('  Carpeta destino: '+$d); Write-Host '================================================'; if($miss -gt 0){ Write-Host ''; Write-Host '  Asi se llaman algunas fotos de la carpeta:'; $fotos | Select-Object -First 5 | ForEach-Object { Write-Host ('      '+$_.Name) } }"
goto fin
:sinruta
echo   [X] No pegaste ninguna ruta.
:fin
echo.
pause
endlocal
