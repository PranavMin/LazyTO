param(
  [string]$Family = "Franklin Gothic Medium",
  [string]$Text = "LazyTO",
  [int]$W = 256,
  [int]$H = 48,
  [double]$Shear = 0.20,
  [int]$Pad = 4,
  [Parameter(Mandatory = $true)][string]$OutRaw,
  [string]$OutPng = ""
)
# Renders the kiosk wordmark with GDI+ (called by kiosk/tools/gen_wordmark.py):
# white text with a baked-in dark drop shadow, sheared to lean like Melee's
# own menu titles, on a transparent canvas. Output: W*H pixels of {intensity,
# alpha} bytes, row-major, which gen_wordmark.py tiles into a GX IA8 texture.
# The PNG preview is composited on navy so it can be looked at.
Add-Type -AssemblyName System.Drawing
$fam = $null
try { $fam = New-Object System.Drawing.FontFamily($Family) } catch { Write-Output "font family '$Family' not installed, using Arial Black"; $fam = New-Object System.Drawing.FontFamily("Arial Black") }
$style = [System.Drawing.FontStyle]::Bold
if (-not $fam.IsStyleAvailable($style)) { $style = [System.Drawing.FontStyle]::Regular }

$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$fmt = [System.Drawing.StringFormat]::GenericTypographic

# Largest size whose sheared, shadowed text fits the canvas.
$size = 44
$fnt = $null
$m = $null
while ($size -gt 8) {
  if ($fnt) { $fnt.Dispose() }
  $fnt = New-Object System.Drawing.Font($fam, [single]$size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $m = $g.MeasureString($Text, $fnt, [int]::MaxValue, $fmt)
  $need = $m.Width + $Shear * $m.Height + 2 * $Pad + 3
  if ($need -le $W -and ($m.Height + 3) -le $H) { break }
  $size -= 1
}
$x = [single]$Pad
$y = [single](($H - $m.Height) / 2 - 1)
# Lean right: x' = x - Shear*y + Shear*H (the top moves right, the bottom stays).
$mx = New-Object System.Drawing.Drawing2D.Matrix(1, 0, (-$Shear), 1, ($Shear * $H), 0)
$g.Transform = $mx
$shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
$g.DrawString($Text, $fnt, $shadow, ($x + 2.5), ($y + 2.5), $fmt)
$g.DrawString($Text, $fnt, [System.Drawing.Brushes]::White, $x, $y, $fmt)
$g.Flush()

if ($OutPng -ne "") {
  $prev = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $pg = [System.Drawing.Graphics]::FromImage($prev)
  $pg.Clear([System.Drawing.Color]::FromArgb(255, 18, 28, 72))
  $pg.DrawImageUnscaled($bmp, 0, 0)
  $pg.Flush()
  $prev.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
}

$bytes = New-Object byte[] ($W * $H * 2)
for ($py = 0; $py -lt $H; $py++) {
  for ($px = 0; $px -lt $W; $px++) {
    $c = $bmp.GetPixel($px, $py)
    $i = [int](0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
    $o = 2 * ($py * $W + $px)
    $bytes[$o] = [byte]$i
    $bytes[$o + 1] = [byte]$c.A
  }
}
[IO.File]::WriteAllBytes($OutRaw, $bytes)
Write-Output ("wordmark: '{0}' {1} {2} {3}px, text {4:0}x{5:0} px, canvas {6}x{7}" -f $Text, $fam.Name, $style, $size, $m.Width, $m.Height, $W, $H)
