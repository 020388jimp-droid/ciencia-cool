# ─────────────────────────────────────────────────────────────────────────────
# Prueba cuales modelos de OpenCode estan disponibles AHORA MISMO.
#
# Por que existe esto: cuando un modelo se agota, OpenCode solo muestra
# "Rate limit exceeded. Please try again later." y no dice cuando vuelve a
# estar disponible. Este script manda un mensaje de una palabra a cada modelo
# y anota el resultado, con la hora, en outputs\modelos-estado.json.
#
#   - Se tarda unos 40-90 segundos (un modelo tras otro).
#   - Cada prueba gasta lo minimo: un mensaje de una palabra.
#   - Las sesiones que crea se borran al terminar: no dejan basura.
#   - La lista de modelos se lee de "opencode models", asi que siempre esta al
#     dia aunque el proveedor anada o quite modelos.
#
# Doble clic en Probar-modelos.bat (o ejecutar este archivo desde PowerShell).
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$archivoEstado = Join-Path $raiz 'outputs\modelos-estado.json'
$segundosPorModelo = 60

# En Windows "opencode" es un shim de PowerShell en AppData\Roaming\npm, no un
# ejecutable: si se lanza con Start-Process tal cual, no arranca. El programa
# de verdad esta en node_modules\@opencode\cli\bin\opencode.exe.
function ExeDeOpenCode {
    $cmd = Get-Command opencode -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $src = $cmd.Source
    if ($src -match '\.exe$') { return $src }
    $candidato = Join-Path $env:APPDATA 'npm\node_modules\@opencode\cli\bin\opencode.exe'
    if (Test-Path $candidato) { return $candidato }
    $cmdShim = $src -replace '\.ps1$', '.cmd'
    if (Test-Path $cmdShim) { return $cmdShim }
    return $src
}

$exe = ExeDeOpenCode
if (-not $exe) {
    Write-Host ''
    Write-Host '  [ERROR] No se encontro "opencode" en el PATH.' -ForegroundColor Red
    Write-Host '  Abre OpenCode una vez desde la terminal para dejarlo instalado.'
    exit 1
}

# ── Lista de modelos, sacada del propio OpenCode ─────────────────────────────
$modelos = @(& opencode models 2>$null) | Where-Object { $_ -match '^opencode/' } | ForEach-Object { $_.Trim() }
if (-not $modelos -or $modelos.Count -eq 0) {
    Write-Host ''
    Write-Host '  [ERROR] No se pudo leer la lista de modelos con "opencode models".' -ForegroundColor Red
    Write-Host '  Abre OpenCode una vez desde la terminal y vuelve a intentarlo.'
    exit 1
}

# ── Estado anterior: para recordar la ultima vez que cada uno funciono ────────
$anterior = @{}
if (Test-Path $archivoEstado) {
    try {
        $datos = Get-Content $archivoEstado -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $datos.modelos.PSObject.Properties) { $anterior[$p.Name] = $p.Value }
    } catch { }
}

function NombreBonito([string]$id) {
    $id -replace '^opencode/', '' -replace '-free$', ''
}

# ── Probar uno por uno ───────────────────────────────────────────────────────
$cuando = (Get-Date).ToUniversalTime().ToString('o')
$resultados = [ordered]@{ }
$sesiones = New-Object System.Collections.ArrayList

Write-Host ''
Write-Host ("  Probando {0} modelos...`n" -f $modelos.Count)

foreach ($id in $modelos) {
    $inicio = Get-Date
    $salida = ''
    $timeOut = $false
    $sesionId = ''

    # PowerShell 5.1 no tiene -Timeout en Start-Process, asi que se usa un
    # trabajo (job) con Wait-Job -Timeout: si un modelo se traba, se corta.
    $trabajo = Start-Job -ScriptBlock {
        param($exe, $idModelo)
        & $exe run -m $idModelo --auto --format json 'hola' 2>&1 | Out-String
    } -ArgumentList $exe, $id

    $completo = Wait-Job $trabajo -Timeout $segundosPorModelo
    if ($completo) {
        $salida = Receive-Job $trabajo
    } else {
        $timeOut = $true
        $salida = Receive-Job $trabajo
    }
    Remove-Job $trabajo -Force -ErrorAction SilentlyContinue

    $segundos = [math]::Round(((Get-Date) - $inicio).TotalSeconds, 1)

    # La sesion que se creo, para borrarla despues
    if ($salida -match '"sessionID":"(ses_[A-Za-z0-9]+)"') { $sesionId = $Matches[1] }
    if ($sesionId) { [void]$sesiones.Add($sesionId) }

    # Clasificar la respuesta
    $texto = ''
    foreach ($linea in ($salida -split "`n")) {
        if ($linea -match '"type":"text"' -and $linea -match '"text":"([^"]*)"') { $texto = $Matches[1]; break }
    }

    if ($timeOut) {
        $estado = 'sin respuesta'
        $detalle = "no contesto en $segundosPorModelo s"
    } elseif ($salida -match 'provider\.quota|rate limit|Rate limit|429|too many requests|Too Many Requests|exceeded|agotado') {
        # Primero se mira el limite de peticiones: OpenCode lo reporta como un
        # error normal ("type":"error" con status 429), y si no se distingue,
        # todos los modelos agotados aparecerian como "error".
        $estado = 'limitado'
        $detalle = 'Rate limit exceeded: se agoto la cuota de peticiones'
    } elseif ($salida -match '"type":"error"') {
        $estado = 'error'
        $detalle = ($salida -replace '\s+', ' ').Trim()
        if ($detalle.Length -gt 100) { $detalle = $detalle.Substring(0, 97) + '...' }
    } elseif ($texto) {
        $estado = 'ok'
        $detalle = ('responde: "{0}"' -f ($texto -replace '\s+', ' ').Trim())
        if ($detalle.Length -gt 70) { $detalle = $detalle.Substring(0, 67) + '...' }
    } else {
        $estado = 'error'
        $detalle = 'no se entiende la salida'
    }

    # Recordar la ultima vez que funciono o fallo
    $ultOk = $null
    $ultFallo = $null
    $viejo = $anterior[$id]
    if ($viejo) {
        if ($viejo.PSObject.Properties['ultimaVezOk'])     { $ultOk = $viejo.ultimaVezOk }
        if ($viejo.PSObject.Properties['ultimaVezFallo']) { $ultFallo = $viejo.ultimaVezFallo }
    }
    if ($estado -eq 'ok') { $ultOk = $cuando } else { $ultFallo = $cuando }
    if ($estado -ne 'ok' -and $ultOk) {
        $detalle += (' · ultimo OK: ' + ([datetime]$ultOk).ToString('HH:mm'))
    }

    $color = 'Red'
    if ($estado -eq 'ok') { $color = 'Green' } elseif ($estado -eq 'limitado') { $color = 'Yellow' }

    Write-Host ("  {0,-32} " -f (NombreBonito $id)) -NoNewline
    Write-Host ("[{0}]" -f $estado) -ForegroundColor $color -NoNewline
    Write-Host ("  ({0} s) {1}" -f $segundos, $detalle)

    $resultados[$id] = [ordered]@{
        nombre         = NombreBonito $id
        estado         = $estado
        hora           = $cuando
        detalle        = $detalle
        ultimaVezOk    = $ultOk
        ultimaVezFallo = $ultFallo
    }
}

# ── Borrar las sesiones de prueba ────────────────────────────────────────────
foreach ($s in $sesiones) {
    try { & opencode session delete $s 2>$null | Out-Null } catch { }
}

# ── Guardar el estado ────────────────────────────────────────────────────────
$ok       = @($resultados.Values | Where-Object { $_.estado -eq 'ok' }).Count
$limitados = @($resultados.Values | Where-Object { $_.estado -eq 'limitado' }).Count
$errores  = $modelos.Count - $ok - $limitados

$objeto = [ordered]@{
    ultimaComprobacion = $cuando
    total     = $modelos.Count
    ok        = $ok
    limitados = $limitados
    errores   = $errores
    modelos   = $resultados
}
$json = $objeto | ConvertTo-Json -Depth 6
$carpeta = Split-Path $archivoEstado
if (-not (Test-Path $carpeta)) { New-Item -ItemType Directory -Force -Path $carpeta | Out-Null }
Set-Content -Path $archivoEstado -Value $json -Encoding UTF8

Write-Host ''
Write-Host '  ------------------------------------------------------------'
Write-Host ("  {0} modelos: {1} disponibles, {2} con limite, {3} con error" -f $modelos.Count, $ok, $limitados, $errores)
Write-Host ''
Write-Host ("  Guardado en: outputs\modelos-estado.json  ({0})" -f (Get-Date).ToString('HH:mm'))
Write-Host '  Vuelve a ejecutarlo cuando quieras: doble clic en Probar-modelos.bat'
Write-Host ''
