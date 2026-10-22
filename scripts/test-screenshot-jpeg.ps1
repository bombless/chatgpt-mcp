param(
    [Nullable[int]]$X,
    [Nullable[int]]$Y,
    [int]$CaptureWidth = 0,
    [int]$CaptureHeight = 0,
    [switch]$HighlightCursor
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Threading;
using System.Runtime.InteropServices;

public class Win32ScreenHelper {
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public static bool CaptureAndGetCursor(int x, int y, int width, int height, Bitmap targetBmp, out POINT cursor) {
        POINT pt = new POINT();
        bool ok = false;
        Exception err = null;
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("default", 0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }
            try {
                using (Graphics g = Graphics.FromImage(targetBmp)) {
                    g.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                }
                GetCursorPos(out pt);
                ok = true;
            } catch (Exception ex) {
                err = ex;
            } finally {
                if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
            }
        });
        t.Start();
        t.Join();
        cursor = pt;
        if (err != null) throw err;
        return ok;
    }
}
"@ -ReferencedAssemblies System.Drawing

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
    $cursor = New-Object Win32ScreenHelper+POINT

    try {
        [Win32ScreenHelper]::CaptureAndGetCursor($captureX, $captureY, $sourceWidth, $sourceHeight, $bmp, [ref]$cursor)
    } catch {
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.CopyFromScreen($captureX, $captureY, 0, 0, $bmp.Size)
        $cursor.X = [System.Windows.Forms.Cursor]::Position.X
        $cursor.Y = [System.Windows.Forms.Cursor]::Position.Y
    }

    # Scale proportionally so the longest edge is at most 1000 pixels.
    $scale = [Math]::Min(1.0, [Math]::Min(1000.0 / $bmp.Width, 1000.0 / $bmp.Height))
    $width = [Math]::Max(1, [int][Math]::Round($bmp.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($bmp.Height * $scale))

    $dst = New-Object System.Drawing.Bitmap($width, $height)
    $dstGraphics = [System.Drawing.Graphics]::FromImage($dst)
    $dstGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $dstGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $dstGraphics.DrawImage($bmp, 0, 0, $width, $height)

    # Highlight cursor if requested and cursor is within the captured area
    if ($HighlightCursor) {
        if ($cursor.X -ge $captureX -and $cursor.X -lt ($captureX + $sourceWidth) -and
            $cursor.Y -ge $captureY -and $cursor.Y -lt ($captureY + $sourceHeight)) {
            $cx = [float](($cursor.X - $captureX) * $scale)
            $cy = [float](($cursor.Y - $captureY) * $scale)

            # 1. Semi-transparent glow halo
            $haloBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 255, 60, 60))
            $dstGraphics.FillEllipse($haloBrush, $cx - 22, $cy - 22, 44, 44)
            $haloBrush.Dispose()

            # 2. Outer red ring
            $redPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 220, 38, 38), 2.5)
            $dstGraphics.DrawEllipse($redPen, $cx - 18, $cy - 18, 36, 36)
            $redPen.Dispose()

            # 3. Inner white ring
            $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 255, 255, 255), 1.5)
            $dstGraphics.DrawEllipse($whitePen, $cx - 12, $cy - 12, 24, 24)
            $whitePen.Dispose()

            # 4. Crosshairs
            $crossPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(240, 220, 38, 38), 2.0)
            $dstGraphics.DrawLine($crossPen, $cx, $cy - 25, $cx, $cy - 14)
            $dstGraphics.DrawLine($crossPen, $cx, $cy + 14, $cx, $cy + 25)
            $dstGraphics.DrawLine($crossPen, $cx - 25, $cy, $cx - 14, $cy)
            $dstGraphics.DrawLine($crossPen, $cx + 14, $cy, $cx + 25, $cy)
            $crossPen.Dispose()

            # 5. Cursor Arrow Pointer
            $arrowPoints = @(
                [System.Drawing.PointF]::new($cx, $cy),
                [System.Drawing.PointF]::new($cx, $cy + 17),
                [System.Drawing.PointF]::new($cx + 4.5, $cy + 13),
                [System.Drawing.PointF]::new($cx + 9, $cy + 21),
                [System.Drawing.PointF]::new($cx + 12, $cy + 19.5),
                [System.Drawing.PointF]::new($cx + 7.5, $cy + 12),
                [System.Drawing.PointF]::new($cx + 13.5, $cy + 12)
            )
            $arrowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
            $dstGraphics.FillPolygon($arrowBrush, $arrowPoints)
            $arrowBrush.Dispose()

            $arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 20, 20, 20), 1.5)
            $dstGraphics.DrawPolygon($arrowPen, $arrowPoints)
            $arrowPen.Dispose()

            # 6. Center hotspot dot
            $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 220, 38, 38))
            $dstGraphics.FillEllipse($dotBrush, $cx - 2, $cy - 2, 4, 4)
            $dotBrush.Dispose()
        }
    }

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
        CursorX         = $cursor.X
        CursorY         = $cursor.Y
    } | Format-List

    # Output cursor coordinates
    Write-Output "SCREENSHOT_CURSOR:{`"x`":$($cursor.X),`"y`":$($cursor.Y)}"
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
