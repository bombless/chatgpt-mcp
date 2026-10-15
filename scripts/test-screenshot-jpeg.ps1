param(
    [Nullable[int]]$X,
    [Nullable[int]]$Y,
    [int]$CaptureWidth = 0,
    [int]$CaptureHeight = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bmp = $null
$graphics = $null
$dst = $null
$dstGraphics = $null
$stream = $null
$verifyStream = $null
$decoded = $null

try {
    # Use the primary display by default; optional bounds select a display region.
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    $bounds = $screen.Bounds
    if ($null -ne $X -and $null -ne $Y -and $CaptureWidth -gt 0 -and $CaptureHeight -gt 0) {
        $captureX = [int]$X
        $captureY = [int]$Y
        $sourceWidth = $CaptureWidth
        $sourceHeight = $CaptureHeight
    }
    else {
        $captureX = $bounds.X
        $captureY = $bounds.Y
        $sourceWidth = $bounds.Width
        $sourceHeight = $bounds.Height
    }

    Write-Host "Display: $($screen.DeviceName)"
    Write-Host "Source resolution: ${sourceWidth}x${sourceHeight}"

    $bmp = New-Object System.Drawing.Bitmap($sourceWidth, $sourceHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($captureX, $captureY, 0, 0, $bmp.Size)

    # Scale proportionally so the longest edge is at most 1000 pixels.
    $scale = [Math]::Min(1.0, [Math]::Min(1000.0 / $bmp.Width, 1000.0 / $bmp.Height))
    $width = [Math]::Max(1, [int][Math]::Round($bmp.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($bmp.Height * $scale))

    $dst = New-Object System.Drawing.Bitmap($width, $height)
    $dstGraphics = [System.Drawing.Graphics]::FromImage($dst)
    $dstGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $dstGraphics.DrawImage($bmp, 0, 0, $width, $height)

    # Encode as JPEG, quality 82.
    $stream = New-Object System.IO.MemoryStream
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' } |
        Select-Object -First 1
    if ($null -eq $codec) { throw 'JPEG encoder not found' }

    $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    try {
        $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [long]82
        )
        $dst.Save($stream, $codec, $encoderParams)
    }
    finally {
        $encoderParams.Dispose()
    }

    $bytes = $stream.ToArray()
    $validHeader = ($bytes.Length -ge 4 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8)
    $validFooter = ($bytes.Length -ge 4 -and $bytes[$bytes.Length - 2] -eq 0xFF -and $bytes[$bytes.Length - 1] -eq 0xD9)

    $verifyStream = New-Object System.IO.MemoryStream(,$bytes)
    $decoded = [System.Drawing.Image]::FromStream($verifyStream)
    $base64 = [Convert]::ToBase64String($bytes)

    if (-not $validHeader -or -not $validFooter -or
        $decoded.Width -gt 1000 -or $decoded.Height -gt 1000 -or
        $base64.Length -eq 0 -or ($base64.Length % 4) -ne 0) {
        throw 'Image validation failed'
    }

    [PSCustomObject]@{
        Result          = 'PASS'
        Format          = $decoded.RawFormat.Guid
        Width           = $decoded.Width
        Height          = $decoded.Height
        WithinLimit     = ($decoded.Width -le 1000 -and $decoded.Height -le 1000)
        JPEGHeaderValid = $validHeader
        JPEGFooterValid = $validFooter
        DecodeValid     = $true
        ImageBytes      = $bytes.Length
        Base64Chars     = $base64.Length
        Base64Valid     = $true
    } | Format-List

    # Node.js extracts this marker so diagnostics never contaminate Base64.
    Write-Output "SCREENSHOT_BASE64:$base64"
    Write-Host 'Screenshot, JPEG encoding, and integrity validation succeeded.' -ForegroundColor Green
}
catch {
    Write-Host "Test failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
    exit 1
}
finally {
    if ($decoded)      { $decoded.Dispose() }
    if ($verifyStream) { $verifyStream.Dispose() }
    if ($stream)       { $stream.Dispose() }
    if ($dstGraphics)  { $dstGraphics.Dispose() }
    if ($dst)          { $dst.Dispose() }
    if ($graphics)     { $graphics.Dispose() }
    if ($bmp)          { $bmp.Dispose() }
}
