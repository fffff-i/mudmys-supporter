param([switch]$ApplyGitHubSettings)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSpec = Get-Content -Raw -LiteralPath (Join-Path $taskRoot '.github/trunk-settings.json') | ConvertFrom-Json
$taskGitRoot = & git -C $taskRoot rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($taskGitRoot) -ne [IO.Path]::GetFullPath($taskRoot)) {
    throw 'Run this script inside the project Git checkout.'
}
$taskOrigin = & git -C $taskRoot remote get-url origin
$taskExpectedOrigin = 'https://github.com/' + $taskSpec.repository + '.git'
if ($LASTEXITCODE -ne 0 -or $taskOrigin -ne $taskExpectedOrigin) {
    throw "The origin must match $taskExpectedOrigin before applying these settings."
}

$taskLocalSettings = [ordered]@{
    'pull.ff' = 'only'
    'merge.ff' = 'only'
    'fetch.prune' = 'true'
    'push.default' = 'simple'
    'push.autoSetupRemote' = 'true'
}
foreach ($taskSetting in $taskLocalSettings.GetEnumerator()) {
    & git -C $taskRoot config --local $taskSetting.Key $taskSetting.Value
    if ($LASTEXITCODE -ne 0) { throw "Could not set $($taskSetting.Key)." }
}
Write-Output 'Repository-local Git settings applied.'
if (-not $ApplyGitHubSettings) { return }

# Use the normal Git credential helper; never print or persist its credentials.
$taskPreviousPrompt = $env:GIT_TERMINAL_PROMPT
$taskHeaders = @{}
try {
    $env:GIT_TERMINAL_PROMPT = '0'
    $taskCredentialRequest = "protocol=https`nhost=github.com`npath=$($taskSpec.repository).git`n`n"
    $taskCredentialLines = $taskCredentialRequest | & git -C $taskRoot -c credential.interactive=never credential fill 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub authentication is unavailable in the Git credential helper.' }
    $taskToken = $null
    foreach ($taskLine in $taskCredentialLines) {
        if ($taskLine.StartsWith('password=')) { $taskToken = $taskLine.Substring(9) }
    }
    $taskCredentialLines = $null
    if (-not $taskToken) { throw 'The Git credential helper did not provide GitHub authentication.' }
    $taskHeaders = @{
        Authorization = 'Bearer ' + $taskToken
        Accept = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent' = 'mudmys-supporter-trunk-setup'
    }
    $taskToken = $null
    $taskApiRoot = 'https://api.github.com/repos/' + $taskSpec.repository

    function Invoke-TrunkApi($Method, $Suffix, $Body) {
        $taskRequest = @{ Method = $Method; Uri = $taskApiRoot + $Suffix; Headers = $taskHeaders }
        if ($null -ne $Body) {
            $taskRequest.ContentType = 'application/json; charset=utf-8'
            $taskRequest.Body = $Body | ConvertTo-Json -Depth 20 -Compress
        }
        try { Invoke-RestMethod @taskRequest }
        catch {
            $taskStatus = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'unavailable' }
            throw "GitHub $Method $Suffix failed (HTTP $taskStatus)."
        }
    }

    $taskRepo = Invoke-TrunkApi 'GET' '' $null
    if (-not $taskRepo.permissions.admin) { throw 'Applying GitHub settings requires repository administration permission.' }
    $null = Invoke-TrunkApi 'PATCH' '' $taskSpec.settings
    $null = Invoke-TrunkApi 'PUT' '/branches/main/protection' $taskSpec.mainProtection
    $taskRepo = Invoke-TrunkApi 'GET' '' $null
    $taskProtection = Invoke-TrunkApi 'GET' '/branches/main/protection' $null
    if ($taskRepo.default_branch -ne 'main' -or -not $taskRepo.allow_squash_merge -or
        $taskRepo.allow_merge_commit -or $taskRepo.allow_rebase_merge -or -not $taskRepo.delete_branch_on_merge -or
        -not $taskProtection.enforce_admins.enabled -or -not $taskProtection.required_linear_history.enabled -or
        -not $taskProtection.required_status_checks.strict -or
        -not ($taskProtection.required_status_checks.checks | Where-Object { $_.context -eq 'Verify' -and $_.app_id -eq 15368 }) -or
        $null -eq $taskProtection.required_pull_request_reviews -or
        $taskProtection.required_pull_request_reviews.required_approving_review_count -ne 0 -or
        -not $taskProtection.required_conversation_resolution.enabled -or
        $taskProtection.allow_force_pushes.enabled -or $taskProtection.allow_deletions.enabled) {
        throw 'GitHub settings verification failed; inspect the repository settings.'
    }
    Write-Output 'GitHub settings verified: protected main, required Verify check, squash merge, and automatic branch deletion.'

    # GitHub currently offers merge queues only for organization-owned repositories.
    if ($taskRepo.owner.type -ne 'Organization') {
        Write-Warning 'Merge Queue is unavailable for personal repositories. The merge_group CI trigger and queue configuration are ready for an organization-owned repository.'
        return
    }
    $taskRulesets = @(Invoke-TrunkApi 'GET' '/rulesets?per_page=100' $null)
    $taskExistingQueue = @($taskRulesets | Where-Object { $_.name -eq $taskSpec.mergeQueueRuleset.name -and $_.source_type -eq 'Repository' })
    if ($taskExistingQueue.Count -gt 1) { throw 'Multiple main merge queue rulesets exist; inspect them before applying settings.' }
    $taskQueue = if ($taskExistingQueue.Count -eq 1) {
        Invoke-TrunkApi 'PUT' ('/rulesets/' + $taskExistingQueue[0].id) $taskSpec.mergeQueueRuleset
    } else {
        Invoke-TrunkApi 'POST' '/rulesets' $taskSpec.mergeQueueRuleset
    }
    $taskQueue = Invoke-TrunkApi 'GET' ('/rulesets/' + $taskQueue.id) $null
    if ($taskQueue.enforcement -ne 'active' -or @($taskQueue.bypass_actors).Count -ne 0 -or
        -not ($taskQueue.rules | Where-Object { $_.type -eq 'merge_queue' -and $_.parameters.merge_method -eq 'SQUASH' })) {
        throw 'Merge Queue verification failed; inspect the repository rulesets.'
    }
    Write-Output 'Merge Queue verified: required queue, squash merge, all checks green, and no bypass actors.'
}
finally {
    $env:GIT_TERMINAL_PROMPT = $taskPreviousPrompt
    $taskCredentialLines = $null
    $taskToken = $null
    $taskHeaders.Clear()
}
