<#
  limpiar-nube.ps1

  Limpia el almacén de imágenes (Artifact Registry) de Google Cloud y deja una
  regla para que no se vuelva a acumular.

  ¿Por qué? Cada vez que se despliega la app, Google guarda una copia completa
  nueva y NUNCA borra las viejas. Tras unos meses son decenas de GB, y eso es el
  único costo real del proyecto. Este script conserva las copias recientes (por
  si hay que regresar a una) y borra el resto.

  NUNCA borra:
    * la imagen que Cloud Run está corriendo ahora mismo,
    * la versión de App Engine que está sirviendo tráfico,
    * la copia con etiqueta "latest" (la que usa el despliegue),
    * las N más recientes de cada aplicación.

  Sin el interruptor -Borrar solo MUESTRA el plan, no toca nada.

  Uso:
    powershell -File scripts\limpiar-nube.ps1                    <- solo el plan
    powershell -File scripts\limpiar-nube.ps1 -Borrar            <- borra (pregunta)
    powershell -File scripts\limpiar-nube.ps1 -Borrar -Si        <- borra sin preguntar
#>
param(
  [string]$Proyecto = 'worklish-76787885-3c342',
  [int]$Conservar = 10,
  [switch]$Borrar,
  [switch]$Si,
  [int]$DiasSinEtiqueta = 7,
  [switch]$SinPoliticas
)

$ErrorActionPreference = 'Continue'
$ubicaciones = @('us', 'us-central1', 'us-east1', 'us-west1', 'northamerica-northeast1', 'southamerica-east1')
$repositorios = @('gcr.io', 'cloud-run-source-deploy', 'worklish-backend')
# NOTA: el repositorio "gae-standard" (App Engine) no se toca aquí. Sus imagenes
# se borran soltando versiones viejas de App Engine, que es la forma segura: se
# conserva la version que esta sirviendo trafico y Google borra las demas.

$conservarPorImagen = @{
  'gcr.io/ciencia-cool'                         = $Conservar
  'gcr.io/worklish-backend'                     = 3
  'gae-standard/default'                        = 3
  'cloud-run-source-deploy/ciencia-cool-studio' = 3
  'cloud-run-source-deploy/worklish-backend'    = 3
  'worklish-backend/worklish-backend-image'     = 3
}

function Localizar-Repo($proyecto, $repo) {
  foreach ($l in $ubicaciones) {
    $ruta = "$l-docker.pkg.dev/$proyecto/$repo"
    $prueba = gcloud artifacts docker images list $ruta --limit=1 --format='value(IMAGE)' 2>&1
    if ($prueba -notmatch 'ERROR|Invalid|not found|PERMISSION|denied') {
      return [pscustomobject]@{ Ruta = $ruta; Ubicacion = $l }
    }
  }
  return $null
}

# Imágenes que Cloud Run corre ahora: intocables.
function ImagenesEnUso($proyecto) {
  $enUso = @()
  $servicios = gcloud run services list --project=$proyecto --format='csv[no-heading](metadata.name,region)' 2>&1
  foreach ($s in @($servicios)) {
    $campos = (($s -replace '"', '').Trim()) -split ','
    if ($campos.Count -lt 2 -or $campos[0] -match 'ERROR') { continue }
    $nombre = $campos[0].Trim()
    $region = $campos[1].Trim()
    $imagen = (gcloud run services describe $nombre --region=$region `
      --format='value(spec.template.spec.containers[0].image)' 2>&1 | Out-String).Trim()
    if ($imagen -and $imagen -notmatch 'ERROR') {
      $enUso += [pscustomobject]@{
        Servicio = $nombre
        Imagen   = $imagen
        Digest   = if ($imagen -match '@(sha256:[0-9a-f]+)') { $matches[1] } else { '' }
      }
    }
  }
  return $enUso
}

# Versiones de App Engine que están sirviendo tráfico: su imagen no se toca.
# Se pregunta al servicio por su reparto de tráfico (fuente autoritativa), no
# se deduce de la lista de versiones: equivocarse aquí tumbaría Worklish.
function VersionesAppEngineSirviendo($proyecto) {
  $res = @()
  $servicios = gcloud app services list --project=$proyecto --format='value(id)' 2>&1
  foreach ($s in @($servicios)) {
    $svc = ($s -replace '"', '').Trim()
    if (-not $svc -or $svc -match 'ERROR|Listing') { continue }
    $json = (gcloud app services describe $svc --project=$proyecto --format='json(split)' 2>&1 | Out-String).Trim()
    try {
      $datos = $json | ConvertFrom-Json
      $alloc = $datos.split.allocations
      if ($alloc) {
        foreach ($prop in $alloc.PSObject.Properties) {
          if ([double]$prop.Value -gt 0) {
            $res += [pscustomobject]@{ Servicio = $svc; Version = $prop.Name; Trafico = $prop.Value }
          }
        }
      }
    } catch {
      Write-Output ("  [aviso] no se pudo leer el reparto de trafico de {0}" -f $svc)
    }
  }
  return $res
}

$enUso = ImagenesEnUso $Proyecto
$digestosEnUso = @($enUso | Where-Object { $_.Digest } | ForEach-Object { $_.Digest })

Write-Output '======================================================'
Write-Output '  LIMPIEZA DEL ALMACEN DE IMAGENES (Artifact Registry)'
Write-Output ("  Proyecto: {0}" -f $Proyecto)
if (-not $Borrar) { Write-Output '  MODO: solo plan (no se borra nada)' }
Write-Output '======================================================'
Write-Output ''
Write-Output 'IMAGENES EN USO (intocables):'
foreach ($u in $enUso) { Write-Output ("  {0,-20} {1}" -f $u.Servicio, $u.Imagen) }
Write-Output ''

$pendientes = @()   # copias que se borrarian
$resumen = @()

foreach ($repo in $repositorios) {
  $info = Localizar-Repo $Proyecto $repo
  if (-not $info) { continue }

  $csv = gcloud artifacts docker images list $info.Ruta --include-tags `
    --format='csv[no-heading](IMAGE,DIGEST,TAGS,CREATE_TIME,SIZE)' 2>&1

  $versiones = @($csv) | Where-Object { $_ -match ',' -and $_ -notmatch '^ERROR' } | ForEach-Object {
    $c = $_ -split ','
    if ($c.Count -ge 5 -and $c[4] -match '^\d+$') {
      [pscustomobject]@{
        Imagen = ($c[0] -split '/')[-1]
        Digest = $c[1]
        Tags   = ($c[2] -replace ';', '/')
        Creado = $c[3]
        MB     = [math]::Round(([double]$c[4] / 1MB), 1)
      }
    }
  }
  if (-not $versiones) { continue }

  foreach ($grupo in ($versiones | Group-Object Imagen)) {
    $orden = $grupo.Group | Sort-Object Creado
    $clave = "$repo/$($grupo.Name)"
    $cuantas = if ($conservarPorImagen.ContainsKey($clave)) { $conservarPorImagen[$clave] } else { 3 }
    $recientes = @($orden | Select-Object -Last $cuantas)

    $queda = @()
    $borra = @()
    foreach ($v in $orden) {
      $razon = ''
      if ($recientes.Digest -contains $v.Digest) { $razon = 'de las mas recientes' }
      elseif ($v.Tags -match '(^|/)latest') { $razon = 'tiene la etiqueta latest' }
      elseif ($digestosEnUso -contains $v.Digest) { $razon = 'EN USO por Cloud Run' }
      if ($razon) { $queda += $v } else { $borra += $v }
    }

    $pesoBorra = [math]::Round((($borra | Measure-Object MB -Sum).Sum) / 1024, 2)
    $pesoQueda = [math]::Round((($queda | Measure-Object MB -Sum).Sum) / 1024, 2)

    $resumen += [pscustomobject]@{
      Repositorio  = $repo
      Imagen       = $grupo.Name
      'GB hoy'     = [math]::Round((($orden | Measure-Object MB -Sum).Sum) / 1024, 1)
      'Conserva'   = $queda.Count
      'GB quedan'  = $pesoQueda
      'Borra'      = $borra.Count
      'GB libera'  = $pesoBorra
    }

    foreach ($v in $borra) {
      $pendientes += [pscustomobject]@{
        Ref    = "$($info.Ruta)/$($grupo.Name)@$($v.Digest)"
        Digest = $v.Digest
        Quien  = $clave
        Creado = $v.Creado
        MB     = $v.MB
      }
    }
  }
}

$resumen | Format-Table -AutoSize | Out-String -Width 200 | Write-Output

$totalHoy = [math]::Round((($resumen | Measure-Object 'GB hoy' -Sum).Sum), 1)
$totalQueda = [math]::Round((($resumen | Measure-Object 'GB quedan' -Sum).Sum), 2)
$totalLibera = [math]::Round((($resumen | Measure-Object 'GB libera' -Sum).Sum), 2)
Write-Output ("TOTAL: {0} GB hoy -> {1} GB despues. Se liberan {2} GB (~{3} USD al mes)." -f `
    $totalHoy, $totalQueda, $totalLibera, [math]::Round($totalLibera * 0.10, 2))
Write-Output ("Copias a borrar: {0}" -f $pendientes.Count)
Write-Output ''

if (-not $Borrar) {
  Write-Output 'Esto fue solo el plan. Para borrar de verdad:'
  Write-Output '  powershell -File scripts\limpiar-nube.ps1 -Borrar'
  return
}

if (-not $Si) {
  $respuesta = Read-Host 'Escribe SI (mayusculas) para borrar estas copias'
  if ($respuesta -ne 'SI') { Write-Output 'Cancelado. No se borro nada.'; return }
}

# ── Borrado de copias viejas ────────────────────────────────────────────────
Write-Output ''
Write-Output 'Borrando copias viejas...'
$borradas = 0
$fallidas = 0
foreach ($p in $pendientes) {
  # Doble candado: jamas se borra algo en uso ni lo mas reciente.
  if ($digestosEnUso -contains $p.Digest) { Write-Output ("  [se omite, esta en uso] {0}" -f $p.Digest); continue }
  $salida = (gcloud artifacts docker images delete $p.Ref --quiet --delete-tags 2>&1 | Out-String)
  if ($salida -match 'ERROR: \(gcloud|Invalid Docker image|PERMISSION_DENIED|was not found') {
    $fallidas++
    Write-Output ("  [no se pudo] {0}: {1}" -f $p.Digest.Substring(0, 19), (($salida -split "`n")[0]))
  } else {
    $borradas++
    if ($borradas % 20 -eq 0) { Write-Output ("  ... {0} borradas" -f $borradas) }
  }
}
Write-Output ("Listo: {0} copias borradas, {1} con problema." -f $borradas, $fallidas)

# ── App Engine: se deja fuera a proposito ────────────────────────────────────
# Las imagenes del repositorio "gae-standard" se borran soltando versiones
# viejas de App Engine (gcloud app versions delete). Eso se hace aparte y a
# mano, para no arriesgar nunca la version que esta sirviendo trafico.

# ── Regla automatica: que no se vuelvan a acumular ──────────────────────────
if (-not $SinPoliticas) {
  Write-Output ''
  Write-Output 'Poniendo la regla automatica (borrar copias sin etiqueta de mas de unos dias)...'
  $politica = @"
[
  {
    "name": "borrar-copias-viejas-sin-etiqueta",
    "action": { "type": "Delete" },
    "condition": { "tagState": "UNTAGGED", "olderThan": "${DiasSinEtiqueta}d" }
  }
]
"@
  $archivoPolitica = Join-Path $env:TEMP 'politica-limpieza.json'
  # Sin BOM: PowerShell 5.1 lo agrega con Set-Content -Encoding UTF8 y entonces
  # gcloud no puede leer el JSON ("Could not read JSON file").
  [System.IO.File]::WriteAllText($archivoPolitica, $politica, (New-Object System.Text.UTF8Encoding($false)))

  foreach ($repo in $repositorios) {
    $info = Localizar-Repo $Proyecto $repo
    if (-not $info) { continue }
    $salida = (gcloud artifacts repositories set-cleanup-policies $repo --project=$Proyecto `
        --location=$($info.Ubicacion) --policy=$archivoPolitica 2>&1 | Out-String)
    if ($salida -match 'ERROR: \(gcloud|gcloud crashed|InvalidUserInputError') { Write-Output ("  [no se pudo] {0}: {1}" -f $repo, (($salida -split "`n")[0])) }
    else { Write-Output ("  OK  {0}: borrara automaticamente las copias sin etiqueta de mas de {1} dias." -f $repo, $DiasSinEtiqueta) }
  }
}

Write-Output ''
Write-Output 'Peso final del almacen:'
$final = (gcloud artifacts repositories list --project=$Proyecto --format='table(name,sizeBytes)' 2>&1 | Out-String)
Write-Output $final
