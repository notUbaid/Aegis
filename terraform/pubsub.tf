# Pub/Sub topics + subscriptions. Every hot topic also has a DLQ.

locals {
  topics = [
    "raw-frames",
    "audio-chunks",
    "sensor-events",
    "perceptual-signals",
    "incident-events",
    "dispatch-events",
    "authority-events",
    "audit-events",
    "learning-examples",
  ]
}

resource "google_pubsub_topic" "topic" {
  for_each   = toset(local.topics)
  name       = each.key
  depends_on = [google_project_service.services]

  # Enable ordering on hot topics — prevents per-venue event reordering.
  # Consumers pick per-venue ordering keys in aegis_shared.pubsub.publish_json.
  message_retention_duration = "604800s" # 7d — buffer while BQ sink catches up

  schema_settings {
    schema   = null
    encoding = "JSON"
  }
}

resource "google_pubsub_topic" "dlq" {
  for_each   = toset(local.topics)
  name       = "${each.key}-dlq"
  depends_on = [google_project_service.services]
}

# Default pull subscriptions per topic — the services use push subscriptions
# that are configured after Cloud Run deploy (see `subscriptions_push.tf`).
resource "google_pubsub_subscription" "pull" {
  for_each = toset(local.topics)
  name     = "${each.key}-pull"
  topic    = google_pubsub_topic.topic[each.key].name

  ack_deadline_seconds       = var.ack_deadline_seconds
  enable_message_ordering    = true
  retain_acked_messages      = false
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = "" # never expire
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq[each.key].id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}
