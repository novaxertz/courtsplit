output "cluster_name" {
  description = "kind cluster name."
  value       = kind_cluster.this.name
}

output "kubeconfig_context" {
  description = "kubectl context created for this cluster."
  value       = "kind-${kind_cluster.this.name}"
}

output "ingress_url" {
  description = "Base URL for the cluster ingress from the host."
  value       = "http://localhost:${var.http_host_port}"
}

output "next_steps" {
  description = "Application deployment is not managed by Terraform."
  value       = <<-EOT
    Cluster is up. Deploy the application with:

      cd backend && docker build -t courtsplit-api:local .
      kind load docker-image courtsplit-api:local --name ${kind_cluster.this.name}
      kubectl --context kind-${kind_cluster.this.name} apply -f deploy/k8s/

    Then: curl http://localhost:${var.http_host_port}/readyz
  EOT
}
