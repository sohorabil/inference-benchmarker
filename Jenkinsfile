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
    stage('Deploy to production') {
      when { branch 'main' }
      steps {
        sh 'npx wrangler deploy'
      }
    }
  }

  post {
    success {
      echo 'Checks passed (and deployed, if on staging or main)'
    }
    failure {
      echo 'Pipeline failed — nothing was deployed'
    }
  }
}
