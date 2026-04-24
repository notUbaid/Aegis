# One service account per Cloud Run service — principle of least privilege.

resource "google_service_account" "service_sa" {
  for_each     = toset(var.cloud_run_services)
  account_id   = each.key
  display_name = "Aegis ${each.key}"
  depends_on   = [google_project_service.services]
}

# All services need to publish/subscribe on Pub/Sub and write structured logs.
locals {
  common_roles = [
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
    "roles/pubsub.publisher",
    "roles/pubsub.subscriber",
    "roles/datastore.user",
    "roles/secretmanager.secretAccessor",
  ]
}

resource "google_project_iam_member" "common" {
  for_each = {
    for pair in flatten([
      for svc in var.cloud_run_services : [
        for role in local.common_roles : {
          key  = "${svc}-${role}"
          svc  = svc
          role = role
        }
      ]
    ]) : pair.key => pair
  }
  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.service_sa[each.value.svc].email}"
}

# Service-specific grants.
resource "google_project_iam_member" "vision_aiplatform" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.service_sa["aegis-vision"].email}"
}

resource "google_project_iam_member" "orchestrator_aiplatform" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.service_sa["aegis-orchestrator"].email}"
}

resource "google_project_iam_member" "orchestrator_bq" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.service_sa["aegis-orchestrator"].email}"
}

resource "google_project_iam_member" "dispatch_bq" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.service_sa["aegis-dispatch"].email}"
}

resource "google_project_iam_member" "ingest_storage" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.service_sa["aegis-ingest"].email}"
}

resource "google_project_iam_member" "vision_storage" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.service_sa["aegis-vision"].email}"
}
