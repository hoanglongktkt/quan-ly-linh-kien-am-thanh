$sampleRate = 22050
$duration = 0.45
$frequency = 880
$numSamples = [int]($sampleRate * $duration)
$amplitude = 12000

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

$bw.Write([char[]]@('R','I','F','F'))
$bw.Write([int](36 + $numSamples * 2))
$bw.Write([char[]]@('W','A','V','E'))
$bw.Write([char[]]@('f','m','t',' '))
$bw.Write([int]16)
$bw.Write([int16]1)
$bw.Write([int16]1)
$bw.Write([int]$sampleRate)
$bw.Write([int]($sampleRate * 2))
$bw.Write([int16]2)
$bw.Write([int16]16)
$bw.Write([char[]]@('d','a','t','a'))
$bw.Write([int]($numSamples * 2))

for ($i = 0; $i -lt $numSamples; $i++) {
  $t = $i / $sampleRate
  $env = if ($t -lt 0.02) { $t / 0.02 } elseif ($t -gt ($duration - 0.08)) { ($duration - $t) / 0.08 } else { 1.0 }
  $sample = [int16]([Math]::Sin(2 * [Math]::PI * $frequency * $t) * $amplitude * $env)
  $bw.Write($sample)
}

$out = Join-Path $PSScriptRoot '..\public\alert.mp3'
[System.IO.File]::WriteAllBytes($out, $ms.ToArray())
Write-Host "Created $out"
