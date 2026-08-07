/**
 * Cluster infrastructure for CourtSplit.
 *
 * Scope note: Terraform owns the *platform* - the cluster, the ingress
 * controller, the metrics pipeline. It does NOT own the application manifests,
 * which stay in deploy/k8s and are applied with kubectl.
 *
 * That split is deliberate rather than laziness. Re-expressing Deployments and
 * Services as HCL duplicates them in a second dialect, and the
 * kubernetes_manifest resource needs the cluster to exist at *plan* time -
 * impossible when the same run creates it. Terraform for infrastructure,
 * Kubernetes-native tooling for workloads, is the common production split.
 */

resource "kind_cluster" "this" {
  name           = var.cluster_name
  node_image     = var.kubernetes_version
  wait_for_ready = true

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"

      # ingress-nginx's kind values select this label. Keeping the controller
      # on the control-plane node matters because that is the only node with
      # the host port mappings below.
      kubeadm_config_patches = [
        <<-EOT
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
        EOT
      ]

      # kind nodes are containers. Without these mappings the cluster's port 80
      # is unreachable from the host and http://localhost:8080 goes nowhere.
      extra_port_mappings {
        container_port = 80
        host_port      = var.http_host_port
        protocol       = "TCP"
      }

      extra_port_mappings {
        container_port = 443
        host_port      = var.https_host_port
        protocol       = "TCP"
      }
    }

    # A second node so Deployment replicas can actually spread.
    node {
      role = "worker"
    }
  }
}

# Both providers read the credentials the kind provider produced, so there is a
# real dependency edge and Terraform orders cluster-then-charts correctly.
provider "kubernetes" {
  host                   = kind_cluster.this.endpoint
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
}

provider "helm" {
  kubernetes = {
    host                   = kind_cluster.this.endpoint
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  }
}

/**
 * ingress-nginx.
 *
 * Installed from the chart rather than the static kind manifest on purpose.
 * The static manifest's nodeSelector dropped `ingress-ready` in
 * controller-v1.15.1, which silently scheduled the controller onto a worker
 * with no host port mappings - the cluster looked healthy and
 * http://localhost:8080 returned an empty reply. Setting the selector
 * explicitly here makes that placement a declared requirement instead of a
 * default we inherit.
 */
resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true

  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  version    = var.ingress_nginx_chart_version

  # Charts install asynchronously; without this the next resource can race a
  # controller that is not serving yet - including its admission webhook, which
  # rejects Ingress objects while it is still starting.
  wait    = true
  timeout = 600

  values = [yamlencode({
    controller = {
      # hostPort + a ClusterIP service is the kind pattern: there is no cloud
      # load balancer, so traffic arrives via the node's own port 80/443.
      hostPort = {
        enabled = true
        ports = {
          http  = 80
          https = 443
        }
      }

      service = {
        type = "ClusterIP"
      }

      nodeSelector = {
        "kubernetes.io/os" = "linux"
        "ingress-ready"    = "true"
      }

      tolerations = [
        {
          key      = "node-role.kubernetes.io/control-plane"
          operator = "Equal"
          effect   = "NoSchedule"
        },
        {
          key      = "node-role.kubernetes.io/master"
          operator = "Equal"
          effect   = "NoSchedule"
        }
      ]

      # Adopt Ingress objects that omit ingressClassName, matching the
      # behaviour of the static kind manifest.
      watchIngressWithoutClass = true

      admissionWebhooks = {
        enabled = true
      }
    }
  })]
}

/**
 * metrics-server.
 *
 * The HorizontalPodAutoscaler reports <unknown> targets without it, so the
 * autoscaler in deploy/k8s is inert until this exists.
 *
 * kind's kubelets serve self-signed certificates that no cluster CA signs, so
 * metrics-server refuses to scrape them unless TLS verification is disabled.
 * Acceptable inside a local cluster; in a managed cluster the kubelet serving
 * certs are properly signed and this flag should not be set.
 */
resource "helm_release" "metrics_server" {
  name      = "metrics-server"
  namespace = "kube-system"

  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = var.metrics_server_chart_version

  wait    = true
  timeout = 600

  values = [yamlencode({
    args = ["--kubelet-insecure-tls"]
  })]
}
