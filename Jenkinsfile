pipeline {
  agent any

  tools {
    nodejs 'NodeJS-16'
  }

  environment {
    POSTMAN_CACHE_DIR = "${JENKINS_HOME}/.postman-cli-cache"
    POSTMAN_BIN = "${JENKINS_HOME}/.postman-cli-cache/PostmanCLI/postman"
    PATH = "${JENKINS_HOME}/.postman-cli-cache/PostmanCLI:${env.PATH}"
  }

  parameters {
    string(name: 'POSTMAN_COLLECTION_ID', defaultValue: '11665959-370bf6fc-eb89-4810-855e-f6240947551a')
    string(name: 'POSTMAN_ENV_ID', defaultValue: '11665959-755ed233-7c04-4b97-b95a-e375ba117495')
    string(name: 'POSTMAN_INTEGRATION_ID', defaultValue: '177801-${JOB_NAME}${BUILD_NUMBER}')
  }

  stages {
    stage('Install Postman CLI') {
      steps {
        sh '''
          set -ex
          CACHE_DIR="$POSTMAN_CACHE_DIR"
          INSTALL_DIR="$CACHE_DIR/PostmanCLI"
          POSTMAN_BIN="$INSTALL_DIR/postman"

          if [ ! -f "$POSTMAN_BIN" ]; then
            echo "⬇️ Installing Postman CLI..."
            mkdir -p "$INSTALL_DIR"
            curl -L -o postman-cli.tar.gz https://dl-cli.pstmn.io/download/latest/linux64
            tar -xzf postman-cli.tar.gz -C "$INSTALL_DIR" --strip-components=1
            chmod +x "$POSTMAN_BIN"
            rm postman-cli.tar.gz
          fi

          "$POSTMAN_BIN" --version
        '''
      }
    }

    stage('Login to Postman CLI') {
      steps {
        withCredentials([string(credentialsId: 'POSTMAN_API_KEY', variable: 'POSTMAN_API_KEY')]) {
          sh '''
            set -ex
            "$POSTMAN_BIN" login --with-api-key "$POSTMAN_API_KEY"
          '''
        }
      }
    }

    stage('Run Postman Collection') {
      steps {
        catchError(buildResult: 'SUCCESS', stageResult: 'FAILURE') {
          sh '''
            set -ex
            "$POSTMAN_BIN" collection run "$POSTMAN_COLLECTION_ID" \
              -e "$POSTMAN_ENV_ID" \
              --integration-id "$POSTMAN_INTEGRATION_ID" \
              --reporters cli,json \
              --reporter-json-export results.json
          '''
        }
      }
    }

    stage('Sync to Jira/Xray') {
      steps {
        withCredentials([
          string(credentialsId: 'JIRA_API_TOKEN', variable: 'JIRA_API_TOKEN'),
          string(credentialsId: 'XRAY_CLIENT_ID', variable: 'XRAY_CLIENT_ID'),
          string(credentialsId: 'XRAY_CLIENT_SECRET', variable: 'XRAY_CLIENT_SECRET')
        ]) {
          sh '''
            set -ex
            node scripts/sync_xray_jira.js results.json
          '''
        }
      }
    }
  }
}
