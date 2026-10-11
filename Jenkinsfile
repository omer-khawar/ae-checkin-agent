// Interim on Jenkins + Argo CD (GitOps). Mirrors .github/workflows/ci.yml, then ships:
//   1. Test     make install && make ci   (ruff, mypy --strict, pytest, eslint, tsc, web and bridge
//               tests, deterministic eval that must be 100%)
//   2. Build    docker build of the API and web images, tagged with the commit
//   3. Push     to $REGISTRY with the "registry-creds" Jenkins credential
//   4. Promote  (main only) write the new tags into deploy/k8s/kustomization.yaml and push that
//               commit; the Argo CD Application in deploy/argocd/ syncs it to the cluster.
// Agent needs: Python 3.12, Node 20, GNU make, Docker, kubectl (for `kubectl kustomize`), git.
// No secret is stored in the repository: registry and Git credentials are Jenkins credentials,
// and the app's own secrets live in the cluster Secret "interim-secrets" (deploy/README.md).
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    timeout(time: 45, unit: 'MINUTES')
  }

  environment {
    REGISTRY  = 'registry.example.org/interim'   // change to your registry
    IMAGE_TAG = "${env.GIT_COMMIT?.take(12) ?: 'dev'}"
  }

  stages {
    stage('Test') {
      steps {
        sh 'make install'
        sh 'make ci'
        sh 'kubectl kustomize deploy/k8s > /dev/null'   // manifests render
      }
    }

    stage('Build images') {
      steps {
        sh 'docker build -f apps/api/Dockerfile -t "$REGISTRY/interim-api:$IMAGE_TAG" .'
        sh 'docker build -t "$REGISTRY/interim-web:$IMAGE_TAG" apps/web'
      }
    }

    stage('Push images') {
      when { branch 'main' }
      steps {
        withCredentials([usernamePassword(credentialsId: 'registry-creds',
                                          usernameVariable: 'REG_USER',
                                          passwordVariable: 'REG_PASS')]) {
          sh 'echo "$REG_PASS" | docker login "${REGISTRY%%/*}" -u "$REG_USER" --password-stdin'
          sh 'docker push "$REGISTRY/interim-api:$IMAGE_TAG"'
          sh 'docker push "$REGISTRY/interim-web:$IMAGE_TAG"'
        }
      }
    }

    stage('Promote (GitOps)') {
      when { branch 'main' }
      steps {
        dir('deploy/k8s') {
          sh 'kubectl kustomize . > /dev/null'
          sh '''
            sed -i "/name: interim-api$/,/newTag:/ s|newTag: .*|newTag: $IMAGE_TAG|" kustomization.yaml
            sed -i "/name: interim-web$/,/newTag:/ s|newTag: .*|newTag: $IMAGE_TAG|" kustomization.yaml
            sed -i "s|newName: .*/interim-api|newName: $REGISTRY/interim-api|; s|newName: .*/interim-web|newName: $REGISTRY/interim-web|" kustomization.yaml
          '''
        }
        withCredentials([usernamePassword(credentialsId: 'git-push-creds',
                                          usernameVariable: 'GIT_USER',
                                          passwordVariable: 'GIT_TOKEN')]) {
          sh '''
            git config user.email "jenkins@example.org"
            git config user.name "Jenkins"
            git add deploy/k8s/kustomization.yaml
            git diff --cached --quiet || git commit -m "deploy: interim images $IMAGE_TAG [skip ci]"
            git push "https://$GIT_USER:$GIT_TOKEN@${GIT_URL#https://}" HEAD:main
          '''
        }
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'docs/eval/results.md', allowEmptyArchive: true
    }
  }
}
