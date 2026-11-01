param(
    [Nullable[int]]$X,
    [Nullable[int]]$Y,
    [int]$CaptureWidth = 0,
    [int]$CaptureHeight = 0,
    [switch]$HighlightCursor
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;

public class ScreenCapturer {
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public static string Capture(int x, int y, int width, int height, bool highlightCursor, out int curX, out int curY) {
        try { SetProcessDpiAwareness(2); } catch {}

        POINT pt = new POINT();
        Bitmap rawBmp = new Bitmap(width, height);
        Exception err = null;

        Thread t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("default", 0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }
            try {
                using (Graphics g = Graphics.FromImage(rawBmp)) {
                    g.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                }
                GetCursorPos(out pt);
            } catch (Exception ex) {
                err = ex;
            } finally {
                if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
            }
        });
        t.Start();
        t.Join();

        if (err != null) {
            using (Graphics g = Graphics.FromImage(rawBmp)) {
                g.CopyFromScreen(x, y, 0, 0, new Size(width, height));
            }
            GetCursorPos(out pt);
        }

        curX = pt.X;
        curY = pt.Y;

        double scale = Math.Min(1.0, Math.Min(1000.0 / width, 1000.0 / height));
        int outW = Math.Max(1, (int)Math.Round(width * scale));
        int outH = Math.Max(1, (int)Math.Round(height * scale));

        using (Bitmap scaledBmp = new Bitmap(outW, outH)) {
            using (Graphics g = Graphics.FromImage(scaledBmp)) {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.DrawImage(rawBmp, 0, 0, outW, outH);

                if (highlightCursor && pt.X >= x && pt.X < x + width && pt.Y >= y && pt.Y < y + height) {
                    float cx = (float)((pt.X - x) * scale);
                    float cy = (float)((pt.Y - y) * scale);

                    using (SolidBrush b = new SolidBrush(Color.FromArgb(90, 255, 60, 60))) {
                        g.FillEllipse(b, cx - 22, cy - 22, 44, 44);
                    }
                    using (Pen p = new Pen(Color.FromArgb(230, 220, 38, 38), 2.5f)) {
                        g.DrawEllipse(p, cx - 18, cy - 18, 36, 36);
                    }
                    using (Pen p = new Pen(Color.FromArgb(230, 255, 255, 255), 1.5f)) {
                        g.DrawEllipse(p, cx - 12, cy - 12, 24, 24);
                    }
                    using (Pen p = new Pen(Color.FromArgb(240, 220, 38, 38), 2.0f)) {
                        g.DrawLine(p, cx, cy - 25, cx, cy - 14);
                        g.DrawLine(p, cx, cy + 14, cx, cy + 25);
                        g.DrawLine(p, cx - 25, cy, cx - 14, cy);
                        g.DrawLine(p, cx + 14, cy, cx + 25, cy);
                    }
                    PointF[] arrow = new PointF[] {
                        new PointF(cx, cy),
                        new PointF(cx, cy + 17),
                        new PointF(cx + 4.5f, cy + 13),
                        new PointF(cx + 9, cy + 21),
                        new PointF(cx + 12, cy + 19.5f),
                        new PointF(cx + 7.5f, cy + 12),
                        new PointF(cx + 13.5f, cy + 12)
                    };
                    using (SolidBrush b = new SolidBrush(Color.White)) {
                        g.FillPolygon(b, arrow);
                    }
                    using (Pen p = new Pen(Color.FromArgb(255, 20, 20, 20), 1.5f)) {
                        g.DrawPolygon(p, arrow);
                    }
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 220, 38, 38))) {
                        g.FillEllipse(b, cx - 2, cy - 2, 4, 4);
                    }
                }
            }
            rawBmp.Dispose();

            ImageCodecInfo jpegCodec = null;
            foreach (var codec in ImageCodecInfo.GetImageEncoders()) {
                if (codec.MimeType == "image/jpeg") {
                    jpegCodec = codec;
                    break;
                }
            }
            if (jpegCodec == null) throw new Exception("JPEG codec not found");

            using (MemoryStream ms = new MemoryStream()) {
                using (EncoderParameters ep = new EncoderParameters(1)) {
                    ep.Param[0] = new EncoderParameter(Encoder.Quality, 82L);
                    scaledBmp.Save(ms, jpegCodec, ep);
                }
                return Convert.ToBase64String(ms.ToArray());
            }
        }
    }
}
"@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds

if ($null -ne $X -and $null -ne $Y -and $CaptureWidth -gt 0 -and $CaptureHeight -gt 0) {
    $captureX = [int]$X
    $captureY = [int]$Y
    $sourceWidth = $CaptureWidth
    $sourceHeight = $CaptureHeight
} else {
    $captureX = $bounds.X
    $captureY = $bounds.Y
    $sourceWidth = $bounds.Width
    $sourceHeight = $bounds.Height
}

[int]$cursorX = 0
[int]$cursorY = 0
$base64 = [ScreenCapturer]::Capture($captureX, $captureY, $sourceWidth, $sourceHeight, [bool]$HighlightCursor, [ref]$cursorX, [ref]$cursorY)

Write-Output "SCREENSHOT_CURSOR:{`"x`":$cursorX,`"y`":$cursorY}"
Write-Output "SCREENSHOT_BASE64:$base64"
