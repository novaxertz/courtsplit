variable "cluster_name" {
  description = "Name of the kind cluster."
  type        = string
  default     = "courtsplit"
}

variable "kubernetes_version" {
  description = "kind node image, which pins the Kubernetes version."
  type        = string
  # Pinned by digest-bearing tag rather than :latest. An unpinned node image
  # means `terraform apply` can silently produce a different Kubernetes version
  # on a different day, which is exactly the drift IaC exists to prevent.
  default = "kindest/node:v1.34.0"
}

variable "http_host_port" {
  description = "Host port mapped to the cluster's ingress HTTP port."
  type        = number
  default     = 8080
}

variable "https_host_port" {
  description = "Host port mapped to the cluster's ingress HTTPS port."
  type        = number
  default     = 8443
}

variable "ingress_nginx_chart_version" {
  description = "ingress-nginx Helm chart version."
  type        = string
  default     = "4.13.9"
}

variable "metrics_server_chart_version" {
  description = "metrics-server Helm chart version."
  type        = string
  default     = "3.13.0"
}
