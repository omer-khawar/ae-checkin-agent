# Deploying Interim

Three ways to run Interim, from simplest to the one a pharma CI/CD environment would use. All three run the same two images: `apps/api/Dockerfile` and `apps/web/Dockerfile`. Every participant is synthetic.

| Path | Files | Use it for |
|---|---|---|
| Docker Compose | [`../docker-compose.yml`](../docker-compose.yml) | A laptop, a judge's clean clone, CI's cold-start smoke test |
| Render blueprint | [`../render.yaml`](../render.yaml) | A public demo URL with no infrastructure of your own |
| Kubernetes + Argo CD + Jenkins | [`k8s/`](k8s/), [`argocd/application.yaml`](argocd/application.yaml), [`../Jenkinsfile`](../Jenkinsfile) | A GitOps environment ("from a Git repo via Jenkins on Argo CD") |

## Kubernetes (`deploy/k8s`, Kustomize)

| File | What it creates |
|---|---|
| `namespace.yaml` | Namespace `interim` |
| `configmap.yaml` | Non-secret API settings (the same variables as `.env.example`) |
| `api.yaml` | PersistentVolumeClaim (SQLite), API Deployment (1 replica, `Recreate`, non-root uid 10001, health probes on `/api/v1/health`), Service on port 8000 |
| `web.yaml` | Web Deployment (nginx, 2 replicas, proxies `/api` to the API Service), Service on port 80 |
| `kustomization.yaml` | Ties them together and sets the image names and tags |
| `secret.example.yaml` | **Example only, never applied.** Shows the keys of the Secret `interim-secrets` |

Secrets are never committed. Create the Secret once per cluster (or use Sealed Secrets, External Secrets or Vault):

```bash
kubectl create namespace interim
kubectl -n interim create secret generic interim-secrets \
  --from-literal=AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DEMO_PASSWORD="<choose one>" \
  --from-literal=BRIDGE_TOKEN="$(openssl rand -hex 16)"
kubectl apply -k deploy/k8s
kubectl -n interim port-forward svc/interim-web 5173:80   # then http://localhost:5173/
```

Not included, add for your cluster: an Ingress (or Route) with TLS in front of `interim-web`; a NetworkPolicy so only `interim-web` reaches `interim-api`; Postgres (set `DATABASE_URL` in the Secret, remove it from the ConfigMap, then the API can run more than one replica).

The **vitals bridge is not deployed to the cluster.** It runs on the kiosk laptop next to the webcam and posts samples to the API with `BRIDGE_TOKEN` ([`docs/VITALS_SOURCES.md`](../docs/VITALS_SOURCES.md)).

## Jenkins + Argo CD (GitOps)

1. **Jenkins** ([`Jenkinsfile`](../Jenkinsfile)) runs the same checks as GitHub Actions (`make install && make ci`: lint, strict types, tests, the deterministic evaluation at 100%), renders the manifests, and builds both images tagged with the commit.
2. On `main` it pushes the images (Jenkins credential `registry-creds`), writes the new tags into `deploy/k8s/kustomization.yaml`, and pushes that commit (credential `git-push-creds`, message ends in `[skip ci]`).
3. **Argo CD** ([`argocd/application.yaml`](argocd/application.yaml)) watches `deploy/k8s` on `main`, sees the commit, and rolls the Deployments (automated sync, prune, self-heal).

Change `REGISTRY` in the Jenkinsfile and `newName` in `kustomization.yaml` to your registry, and `repoURL` in the Application if you fork.

**Status:** the manifests render (`kubectl kustomize deploy/k8s`, checked in CI) and follow the compose settings, but they have not been applied to a live cluster by this team. The compose path is the one rehearsed.
