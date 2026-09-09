pipeline {
  agent any

  environment {
    CLOUDFLARE_API_TOKEN = credentials('cloudflare-api-token-bechhmark')
  }

  stages {
    stage('Install dependencies') {
      steps {
        sh 'npm install'
      }
    }
    stage('Type check') {
      steps {
        sh 'npx tsc --noEmit'
      }
    }
    stage('Deploy to staging') {
      when { branch 'staging' }
      steps {
        sh 'npx wrangler deploy --env staging'
      }
    }
  }

  post {
    success {
      echo 'Checks passed (and deployed to staging, if on that branch)'
    }
    failure {
      echo 'Pipeline failed — nothing was deployed'
    }
  }
}
