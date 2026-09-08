pipeline {
  agent any

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
  }

  post {
    success {
      echo 'dev checks passed — safe to promote to staging'
    }
    failure {
      echo 'dev checks failed — do not promote'
    }
  }
}
