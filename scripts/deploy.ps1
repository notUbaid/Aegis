# Deploy Aegis Phase 1 services to Cloud Run.
#
# Prerequisites:
#   - gcloud auth configure-docker asia-south1-docker.pkg.dev
#   - Artifact Registry repo `aegis` created:
#       gcloud artifacts repositories create aegis `
#         --repository-format=docker --location=asia-south1
#
# Usage: run from repo root:   .\scripts\deploy.ps1

$ErrorActionPreference = "Stop"

$Project = & gcloud config get-value project
$Region = "asia-south1"
$Repo = "$Region-docker.pkg.dev/$Project/aegis"

$Services = @(
  @{ name = "ingest";       port = 8001 },
  @{ name = "vision";       port = 8002 },
  @{ name = "orchestrator"; port = 8003 },
  @{ name = "dispatch";     port = 8004 }
)

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Push-Location $repoRoot
try {
  foreach ($svc in $Services) {
    $name = $svc.name
    $image = "$Repo/aegis-$name`:latest"
    Write-Host "`n=== Building aegis-$name ($image) ===" -ForegroundColor Cyan

    # Build with the repo root as context so the Dockerfile can COPY services/shared, agents/, prompts/.
    gcloud builds submit `
      --tag $image `
      --timeout=20m `
      --region=$Region `
      --config=- `
      --substitutions=_IMAGE=$image,_DOCKERFILE=services/$name/Dockerfile `
      <<'__YAML__'
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "${_DOCKERFILE}", "-t", "${_IMAGE}", "."]
images: ["${_IMAGE}"]
__YAML__

    Write-Host "=== Deploying aegis-$name to Cloud Run ===" -ForegroundColor Cyan
    gcloud run deploy "aegis-$name" `
      --image $image `
      --region $Region `
      --platform managed `
      --allow-unauthenticated `
      --port $svc.port `
      --min-instances 0 `
      --max-instances 5 `
      --memory 1Gi `
      --cpu 1 `
      --timeout=300 `
      --service-account "aegis-$name@$Project.iam.gserviceaccount.com" `
      --set-env-vars "AEGIS_ENV=prod,GCP_PROJECT_ID=$Project,GCP_REGION=$Region,VERTEX_AI_LOCATION=$Region"
  }
}
finally {
  Pop-Location
}

Write-Host "`nAll services deployed." -ForegroundColor Green
gcloud run services list --region $Region --format="table(metadata.name,status.url)"
