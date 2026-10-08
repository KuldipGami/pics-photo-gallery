# Lumen's text recognition engine: Windows' own OCR (Windows.Media.Ocr), offline.
# ocr.cjs copies this file next to its cache (app.asar can't be run from) and starts it with -File
# (an -EncodedCommand child gets killed by security software after a few seconds). It answers one
# request per line until stdin closes, so PowerShell and WinRT start only once.
#   in:  <seq> TAB f TAB <file path>     TAB <max side> TAB <small side>   a file Windows can decode
#        <seq> TAB b TAB <base64 of a JPEG/PNG> TAB <max side> TAB <small side>
#        Pictures are scaled so the long side is at most <max side>; smaller than <small side>: doubled.
#   out: {"ready":true,"lang":"en-US","max":10000} once, then per request
#        {"seq":1,"ok":true,"w":..,"h":..,"angle":..,"decode":ms,"ms":ms,"lines":[{"t":"..","b":[x,y,w,h]}]}
#        {"seq":1,"ok":false,"stage":"decode"|"ocr","error":".."}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding($false)
$stdout = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false, 1048576)

function Send([string]$json) { $stdout.WriteLine($json) }
function Quote([string]$s) { '"' + [Web.HttpUtility]::JavaScriptStringEncode($s) + '"' }
function Message($err) {
  $e = $err.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  ($e.Message -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime, System.Web
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $asTask = [WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1'
  } | Select-Object -First 1
  $asDecoder = $asTask.MakeGenericMethod([Windows.Graphics.Imaging.BitmapDecoder])
  $asBitmap = $asTask.MakeGenericMethod([Windows.Graphics.Imaging.SoftwareBitmap])
  $asResult = $asTask.MakeGenericMethod([Windows.Media.Ocr.OcrResult])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    $first = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1
    if ($first) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($first) }
  }
  if ($null -eq $engine) { Send '{"ready":false,"error":"no-language"}'; exit 0 }
  $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  Send ('{"ready":true,"lang":' + (Quote $engine.RecognizerLanguage.LanguageTag) + ',"max":' + $maxDim + '}')
} catch {
  Send ('{"ready":false,"error":' + (Quote (Message $_)) + '}')
  exit 0
}

function Await($method, $operation) {
  $task = $method.Invoke($null, @($operation))
  if (-not $task.Wait(60000)) { throw 'Timed out' }
  $task.Result
}

# The picture in the stream, upright (EXIF orientation), scaled for reading.
function Decode([IO.Stream]$stream, [int]$max, [int]$small) {
  try {
    $decoder = Await $asDecoder ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)))
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $long = [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight)
    $scale = 1.0
    if ($long -lt $small) { $scale = [Math]::Min(2.0, $max / $long) }
    elseif ($long -gt $max) { $scale = $max / $long }
    $scale = [Math]::Min($scale, ($maxDim - 1) / $long)
    if ([Math]::Abs($scale - 1.0) -gt 0.01) {
      $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($decoder.PixelWidth * $scale))
      $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($decoder.PixelHeight * $scale))
      if ($scale -lt 1) { $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant }
      else { $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic }
    }
    Await $asBitmap ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage))
  } finally {
    $stream.Dispose()
  }
}

$tab = [char]9
while ($null -ne ($line = $stdin.ReadLine())) {
  if ($line -eq 'quit') { break }
  $seq = 0
  $bitmap = $null
  $stage = 'decode'
  try {
    $parts = $line.Split($tab)
    $seq = [int]$parts[0]
    $max = [int]$parts[3]
    $small = [int]$parts[4]
    $clock = [Diagnostics.Stopwatch]::StartNew()
    if ($parts[1] -eq 'f') { $bitmap = Decode ([IO.File]::Open($parts[2], 'Open', 'Read', 'ReadWrite, Delete')) $max $small }
    elseif ($parts[1] -eq 'b') { $bitmap = Decode (New-Object IO.MemoryStream(, [Convert]::FromBase64String($parts[2]))) $max $small }
    else { throw 'Unknown request' }
    $decoded = $clock.ElapsedMilliseconds
    $stage = 'ocr'
    $result = Await $asResult ($engine.RecognizeAsync($bitmap))
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('{"seq":').Append($seq).Append(',"ok":true,"w":').Append($bitmap.PixelWidth).Append(',"h":').Append($bitmap.PixelHeight)
    if ($null -ne $result.TextAngle) { [void]$sb.Append(',"angle":').Append([Math]::Round($result.TextAngle, 1).ToString([Globalization.CultureInfo]::InvariantCulture)) }
    [void]$sb.Append(',"decode":').Append($decoded).Append(',"ms":').Append($clock.ElapsedMilliseconds).Append(',"lines":[')
    $first = $true
    foreach ($l in $result.Lines) {
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0.0; $y1 = 0.0
      foreach ($word in $l.Words) {
        $r = $word.BoundingRect
        $x0 = [Math]::Min($x0, $r.X); $y0 = [Math]::Min($y0, $r.Y)
        $x1 = [Math]::Max($x1, $r.X + $r.Width); $y1 = [Math]::Max($y1, $r.Y + $r.Height)
      }
      if (-not $first) { [void]$sb.Append(',') }
      $first = $false
      [void]$sb.Append('{"t":').Append((Quote $l.Text)).Append(',"b":[').Append([int]$x0).Append(',').Append([int]$y0).Append(',').Append([int]($x1 - $x0)).Append(',').Append([int]($y1 - $y0)).Append(']}')
    }
    [void]$sb.Append(']}')
    Send $sb.ToString()
  } catch {
    try { Send ('{"seq":' + $seq + ',"ok":false,"stage":"' + $stage + '","error":' + (Quote (Message $_)) + '}') } catch { break }
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
  }
  # Decoders hold their native buffers until finalized: without this a process grows to ~700 MB.
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
