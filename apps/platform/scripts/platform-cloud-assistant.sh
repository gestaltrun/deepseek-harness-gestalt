#!/usr/bin/env bash

platform_cloud_run() {
  local instance_id="$1" command_file="$2" command_timeout="${3:-300}"
  local command_content response invoke_id result status exit_code error_code error_info
  local attempt max_attempts

  command_content=$(base64 < "$command_file" | tr -d '\n')
  response=$(aliyun ecs RunCommand \
    --RegionId "$PLATFORM_ALIYUN_REGION" \
    --Type RunShellScript \
    --CommandContent "$command_content" \
    --ContentEncoding Base64 \
    --InstanceId.1 "$instance_id" \
    --KeepCommand false \
    --TerminationMode ProcessTree \
    --Timeout "$command_timeout" \
    --Username root \
    --Name "gestalt-platform-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}")
  invoke_id=$(jq -er '.InvokeId' <<< "$response")
  max_attempts=$((command_timeout / 5 + 12))

  for attempt in $(seq 1 "$max_attempts"); do
    result=$(aliyun ecs DescribeInvocationResults \
      --RegionId "$PLATFORM_ALIYUN_REGION" \
      --InvokeId "$invoke_id" \
      --InstanceId "$instance_id")
    status=$(jq -r '.Invocation.InvocationResults.InvocationResult[0].InvocationStatus // "Pending"' <<< "$result")
    case "$status" in
      Success)
        exit_code=$(jq -er '.Invocation.InvocationResults.InvocationResult[0].ExitCode' <<< "$result")
        if [ "$exit_code" = 0 ]; then
          return 0
        fi
        ;;
      Pending|Running|Stopping)
        sleep 5
        continue
        ;;
    esac
    exit_code=$(jq -r '.Invocation.InvocationResults.InvocationResult[0].ExitCode // "unknown"' <<< "$result")
    error_code=$(jq -r '.Invocation.InvocationResults.InvocationResult[0].ErrorCode // ""' <<< "$result")
    error_info=$(jq -r '.Invocation.InvocationResults.InvocationResult[0].ErrorInfo // ""' <<< "$result")
    printf 'platform: cloud command failed on %s: status=%s exit=%s code=%s info=%s\n' \
      "$instance_id" "$status" "$exit_code" "$error_code" "$error_info" >&2
    return 1
  done

  printf 'platform: cloud command timed out on %s: invocation=%s\n' "$instance_id" "$invoke_id" >&2
  return 1
}
