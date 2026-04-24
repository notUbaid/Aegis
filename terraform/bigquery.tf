# BigQuery — audit (append-only, hash-chained), analytics views, learning store.

resource "google_bigquery_dataset" "audit" {
  dataset_id                 = var.bq_audit_dataset
  location                   = var.region
  delete_contents_on_destroy = false
  depends_on                 = [google_project_service.services]
  description                = "Immutable Aegis audit log. Rows are SHA-256 chained per incident."
}

resource "google_bigquery_dataset" "analytics" {
  dataset_id                 = var.bq_analytics_dataset
  location                   = var.region
  delete_contents_on_destroy = false
  depends_on                 = [google_project_service.services]
  description                = "Aegis analytics views over audit + fact tables."
}

resource "google_bigquery_dataset" "learning" {
  dataset_id                 = var.bq_learning_dataset
  location                   = var.region
  delete_contents_on_destroy = false
  depends_on                 = [google_project_service.services]
  description                = "Resolved-incident training examples for the learning loop."
}

# Mirror of blueprint §25.1.
resource "google_bigquery_table" "audit_events" {
  dataset_id          = google_bigquery_dataset.audit.dataset_id
  table_id            = "events"
  deletion_protection = true
  description         = "Append-only audit events with SHA-256 chain."

  time_partitioning {
    type  = "DAY"
    field = "event_time"
  }

  clustering = ["venue_id", "incident_id"]

  schema = jsonencode([
    { name = "event_id", type = "STRING", mode = "REQUIRED" },
    { name = "event_time", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "venue_id", type = "STRING", mode = "REQUIRED" },
    { name = "incident_id", type = "STRING", mode = "NULLABLE" },
    { name = "actor_type", type = "STRING", mode = "NULLABLE" },
    { name = "actor_id", type = "STRING", mode = "NULLABLE" },
    { name = "action", type = "STRING", mode = "NULLABLE" },
    { name = "input_hash", type = "STRING", mode = "NULLABLE" },
    { name = "output_hash", type = "STRING", mode = "NULLABLE" },
    { name = "prev_hash", type = "STRING", mode = "NULLABLE" },
    { name = "row_hash", type = "STRING", mode = "NULLABLE" },
    { name = "model_version", type = "STRING", mode = "NULLABLE" },
    { name = "confidence", type = "FLOAT", mode = "NULLABLE" },
    { name = "explanation", type = "STRING", mode = "NULLABLE" },
    { name = "extra", type = "JSON", mode = "NULLABLE" },
  ])
}
