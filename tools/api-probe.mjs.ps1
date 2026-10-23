# 全接口实测脚本：HomeHub :4020 + Gateway :4030
$ErrorActionPreference = "Continue"
$H = "http://127.0.0.1:4020/v1"
$G = "http://127.0.0.1:4030"
$tok = @{ authorization = "Bearer dev-user-token" }
function Log($m){ Write-Host "`n== $m ==" -ForegroundColor Cyan }

Log "Hub GET /health"
try { $r=Invoke-RestMethod "$H/health" -Headers $tok -TimeoutSec 8; "ok=$($r.ok) adapter=$($r.adapter.status) llm=$($r.llm.status) db=$($r.db.status)" } catch { "FAIL $_" }

Log "Hub GET /entities"
try { $e=Invoke-RestMethod "$H/entities" -Headers $tok -TimeoutSec 8; "count=$($e.Count) first=$($e[0].id) type=$($e[0].type)" } catch { "FAIL $_" }

Log "Hub GET /entities/:id"
try { $one=Invoke-RestMethod "$H/entities" -Headers $tok -TimeoutSec 8; $id=$one[0].id; $x=Invoke-RestMethod "$H/entities/$id" -Headers $tok -TimeoutSec 8; "id=$($x.id) name=$($x.name)" } catch { "FAIL $_" }

Log "Hub POST /entities/:id/command (turn_on)"
try { $one=Invoke-RestMethod "$H/entities" -Headers $tok -TimeoutSec 8; $id=($one | Where-Object { $_.type -eq "light" } | Select-Object -First 1).id; $b=@{service="turn_on";data=@{}}|ConvertTo-Json -Compress; $r=Invoke-RestMethod "$H/entities/$id/command" -Method Post -Headers $tok -ContentType "application/json" -Body $b -TimeoutSec 8; "ok=$($r.ok) state=$($r.state)" } catch { "FAIL $_" }

Log "Hub GET /scenes"
try { $s=Invoke-RestMethod "$H/scenes" -Headers $tok -TimeoutSec 8; "count=$($s.Count) names=$($s.name -join ',')" } catch { "FAIL $_" }

Log "Hub POST /scenes/:id/run"
try { $s=Invoke-RestMethod "$H/scenes" -Headers $tok -TimeoutSec 8; if($s.Count){ $r=Invoke-RestMethod "$H/scenes/$($s[0].id)/run" -Method Post -Headers $tok -TimeoutSec 15; "ok=$($r.ok) steps=$($r.results.Count)" } else { "no scenes" } } catch { "FAIL $_" }

Log "Hub GET /sessions"
try { $ss=Invoke-RestMethod "$H/sessions" -Headers $tok -TimeoutSec 8; "count=$($ss.Count) first=$($ss[0].id)" } catch { "FAIL $_" }

Log "Hub POST /sessions"
try { $r=Invoke-RestMethod "$H/sessions" -Method Post -Headers $tok -ContentType "application/json" -Body '{"title":"api-test"}' -TimeoutSec 8; "id=$($r.id) title=$($r.title)"; $global:sid=$r.id } catch { "FAIL $_" }

Log "Hub GET /sessions/:id/messages"
try { $m=Invoke-RestMethod "$H/sessions/$($global:sid)/messages" -Headers $tok -TimeoutSec 8; "count=$($m.Count)" } catch { "FAIL $_" }

Log "Hub GET /audit"
try { $a=Invoke-RestMethod "$H/audit?limit=5" -Headers $tok -TimeoutSec 8; "count=$($a.Count)" } catch { "FAIL $_" }

Log "Hub GET /automations"
try { $au=Invoke-RestMethod "$H/automations" -Headers $tok -TimeoutSec 8; "count=$($au.Count)"; $global:aid=$au[0].id } catch { "FAIL $_" }

Log "Hub POST /automations/:id/enable (on=true)"
try { if($global:aid){ $b='{"on":true}'; $r=Invoke-RestMethod "$H/automations/$($global:aid)/enable" -Method Post -Headers $tok -ContentType "application/json" -Body $b -TimeoutSec 8; "ok=$($r.ok) enabled=$($r.enabled)" } else { "no rules" } } catch { "FAIL $_" }

Log "Hub GET /automations/history"
try { $h=Invoke-RestMethod "$H/automations/history?limit=5" -Headers $tok -TimeoutSec 8; "count=$($h.Count)" } catch { "FAIL $_" }

Log "Hub GET /automations/triggers"
try { $t=Invoke-RestMethod "$H/automations/triggers?limit=5" -Headers $tok -TimeoutSec 8; "count=$($t.Count)" } catch { "FAIL $_" }

Log "Hub POST /attachments (1x1 png)"
try { $png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="; $b=@{name="t.png";mime="image/png";data=$png}|ConvertTo-Json -Compress; $r=Invoke-RestMethod "$H/attachments" -Method Post -Headers $tok -ContentType "application/json" -Body $b -TimeoutSec 8; "id=$($r.id) kind=$($r.kind) size=$($r.size)"; $global:attid=$r.id } catch { "FAIL $_" }

Log "Hub GET /attachments/:id (bytes)"
try { $r=Invoke-WebRequest "$H/attachments/$($global:attid)" -Headers $tok -UseBasicParsing -TimeoutSec 8; "status=$($r.StatusCode) bytes=$($r.RawContentLength)" } catch { "FAIL $_" }

Log "Hub DELETE /attachments/:id"
try { $r=Invoke-RestMethod "$H/attachments/$($global:attid)" -Method Delete -Headers $tok -TimeoutSec 8; "ok=$($r.ok)" } catch { "FAIL $_" }

Log "GW GET /v1/models"
try { $r=Invoke-RestMethod "$G/v1/models" -TimeoutSec 8; "active=$($r.active_id) count=$($r.models.Count)" } catch { "FAIL $_" }

Log "GW POST /v1/models (create)"
try { $b=@{name="ApiProbe";baseUrl="https://api.example.com/v1";model="probe-1";apiKey="sk-probe";wireApi="chat_completions"}|ConvertTo-Json -Compress; $r=Invoke-RestMethod "$G/v1/models" -Method Post -ContentType "application/json" -Body $b -TimeoutSec 8; "id=$($r.id) name=$($r.name) wire=$($r.wireApi)"; $global:mid=$r.id } catch { "FAIL $_" }

Log "GW PUT /v1/models/:id (update)"
try { $b=@{name="ApiProbe2";reasoningEffort="high";contextWindow=128000}|ConvertTo-Json -Compress; $r=Invoke-RestMethod "$G/v1/models/$($global:mid)" -Method Put -ContentType "application/json" -Body $b -TimeoutSec 8; "name=$($r.name) effort=$($r.reasoningEffort) ctx=$($r.contextWindow)" } catch { "FAIL $_" }

Log "GW PUT /v1/models/active"
try { $b=@{id=$global:mid}|ConvertTo-Json -Compress; $r=Invoke-RestMethod "$G/v1/models/active" -Method Put -ContentType "application/json" -Body $b -TimeoutSec 8; "ok=$($r.ok) active=$($r.active_id)" } catch { "FAIL $_" }

Log "GW POST /v1/models/:id/test (期望返回上游错误，不是 500)"
try { $r=Invoke-RestMethod "$G/v1/models/$($global:mid)/test" -Method Post -TimeoutSec 20; "ok=$($r.ok) latency=$($r.latency_ms) msg=$($r.message)" } catch { "FAIL $_" }

Log "GW DELETE /v1/models/:id"
try { $r=Invoke-RestMethod "$G/v1/models/$($global:mid)" -Method Delete -TimeoutSec 8; "ok=$($r.ok)" } catch { "FAIL $_" }

Log "GW POST /v1/chat/message (SSE 触发)"
try { $envBody=@{type="run.start";session_id=$global:sid;payload=@{input="打开客厅灯"}}|ConvertTo-Json -Compress -Depth 5; $r=Invoke-WebRequest "$G/v1/chat/message" -Method Post -ContentType "application/json" -Body $envBody -UseBasicParsing -TimeoutSec 20; "status=$($r.StatusCode) body=$($r.Content.Substring(0,[Math]::Min(120,$r.Content.Length)))" } catch { "FAIL $_" }

Log "GW GET /v1/stream (SSE 3 秒)"
try { $c=New-Object System.Net.Sockets.TcpClient("127.0.0.1",4030); $c.Close(); $r=Invoke-WebRequest "$G/v1/stream?session_id=$($global:sid)&last_seq=0" -Headers @{accept="text/event-stream"} -UseBasicParsing -TimeoutSec 3; "status=$($r.StatusCode)" } catch { $resp=$_.Exception.Response; if($resp){ "status=" + [int]$resp.StatusCode + " (流保持打开属正常)" } else { "FAIL $($_.Exception.Message)" } }

Write-Host "`n=== DONE ===" -ForegroundColor Green
