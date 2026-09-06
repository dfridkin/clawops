#!/usr/bin/env bash
# Tear down every resource tagged Project=clawops-spike in account 614126170912.
# Written before provisioning, deliberately: teardown must never depend on the session
# that created the stack still being alive.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-clawops-spike}"
REGION="${AWS_REGION:-us-east-1}"
TAG="Project=clawops-spike"
echo "== teardown: $TAG in $(aws sts get-caller-identity --query Account --output text) / $REGION"

ids=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Project,Values=clawops-spike" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$ids" ]; then
  echo "-- terminating: $ids"
  aws ec2 terminate-instances --region "$REGION" --instance-ids $ids >/dev/null
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids $ids
  echo "-- terminated"
else
  echo "-- no instances"
fi

# Spot requests can outlive their instance and relaunch. Cancel explicitly.
sr=$(aws ec2 describe-spot-instance-requests --region "$REGION" \
  --filters "Name=tag:Project,Values=clawops-spike" "Name=state,Values=open,active" \
  --query 'SpotInstanceRequests[].SpotInstanceRequestId' --output text)
[ -n "$sr" ] && { echo "-- cancelling spot requests: $sr"; aws ec2 cancel-spot-instance-requests --region "$REGION" --spot-instance-request-ids $sr >/dev/null; }

# Orphaned volumes (root volumes are DeleteOnTermination, but verify)
vols=$(aws ec2 describe-volumes --region "$REGION" \
  --filters "Name=tag:Project,Values=clawops-spike" "Name=status,Values=available" \
  --query 'Volumes[].VolumeId' --output text)
[ -n "$vols" ] && { echo "-- deleting volumes: $vols"; for v in $vols; do aws ec2 delete-volume --region "$REGION" --volume-id "$v"; done; }

# Elastic IPs cost MORE when unattached — check even though we allocate none.
eips=$(aws ec2 describe-addresses --region "$REGION" \
  --filters "Name=tag:Project,Values=clawops-spike" --query 'Addresses[].AllocationId' --output text)
[ -n "$eips" ] && { echo "-- releasing EIPs: $eips"; for e in $eips; do aws ec2 release-address --region "$REGION" --allocation-id "$e"; done; }

sgs=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=tag:Project,Values=clawops-spike" --query 'SecurityGroups[].GroupId' --output text)
[ -n "$sgs" ] && { echo "-- deleting security groups: $sgs"; for g in $sgs; do aws ec2 delete-security-group --region "$REGION" --group-id "$g" 2>/dev/null || echo "   (retry $g: still in use)"; done; }

kps=$(aws ec2 describe-key-pairs --region "$REGION" \
  --filters "Name=tag:Project,Values=clawops-spike" --query 'KeyPairs[].KeyName' --output text)
[ -n "$kps" ] && { echo "-- deleting key pairs: $kps"; for k in $kps; do aws ec2 delete-key-pair --region "$REGION" --key-name "$k"; done; }

# IAM: instance profiles and roles are not tagged-searchable the same way; handle by name.
# (Found during the 2026-09-04 run: the first version of this script missed IAM entirely.)
for RN in clawops-spike-bedrock; do
  if aws iam get-role --role-name "$RN" >/dev/null 2>&1; then
    echo "-- cleaning IAM role $RN"
    aws iam remove-role-from-instance-profile --instance-profile-name "$RN" --role-name "$RN" 2>/dev/null
    aws iam delete-instance-profile --instance-profile-name "$RN" 2>/dev/null
    for P in $(aws iam list-attached-role-policies --role-name "$RN" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "$RN" --policy-arn "$P" 2>/dev/null
    done
    aws iam delete-role --role-name "$RN" 2>/dev/null
  fi
done

echo
echo "== remaining billable resources in $REGION =="
echo "instances : $(aws ec2 describe-instances --region "$REGION" --filters 'Name=instance-state-name,Values=pending,running,stopping,stopped' --query 'length(Reservations[].Instances[])' --output text)"
echo "volumes   : $(aws ec2 describe-volumes --region "$REGION" --query 'length(Volumes)' --output text)"
echo "eips      : $(aws ec2 describe-addresses --region "$REGION" --query 'length(Addresses)' --output text)"
echo "snapshots : $(aws ec2 describe-snapshots --region "$REGION" --owner-ids self --query 'length(Snapshots)' --output text)"
echo "== done =="
