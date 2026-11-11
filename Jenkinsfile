
pipeline {
    agent any

    stages {
        stage('Build Docker Image') {
            steps {
                sh 'docker build -t task-api:${BUILD_NUMBER} .'
            }
        }
    }
}
