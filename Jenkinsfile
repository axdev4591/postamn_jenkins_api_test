pipeline {
  agent any

  tools {
    nodejs 'NodeJS-16'
  }

  environment {
    POSTMAN_CACHE_DIR = "${JENKINS_HOME}/.postman-cli-cache"
    POSTMAN_BIN = "${JENKINS_HOME}/.postman-cli-cache/PostmanCLI/postman"
    PATH = "${JENKINS_HOME}/.postman-cli-cache/PostmanCLI:${env.PATH}"

    JIRA_BASE_URL = 'https://axelmouele4591.atlassian.net'
    JIRA_PROJECT_KEY = 'IDC'
    BUG_ISSUE_TYPE = 'Bug'
    XRAY_BASE_URL = 'https://xray.cloud.getxray.app'
    JIRA_USER = 'axelmouele4591@gmail.com' // Change as needed
    REPORT_RECIPIENTS='axelmouele4591@gmail.com,axdev2020@gmail.com'
  }

  parameters {
    string(name: 'POSTMAN_COLLECTION_ID', defaultValue: '11665959-370bf6fc-eb89-4810-855e-f6240947551a')
    string(name: 'POSTMAN_ENV_ID', defaultValue: '11665959-755ed233-7c04-4b97-b95a-e375ba117495')
    string(name: 'POSTMAN_INTEGRATION_ID', defaultValue: '177801-${JOB_NAME}${BUILD_NUMBER}')
  }

  stages {

    stage('Checkout Repository') {
      steps {
        checkout scm
      }
    }

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
        catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
          sh '''
            set -ex
            "$POSTMAN_BIN" collection run "$POSTMAN_COLLECTION_ID" \
              -e "$POSTMAN_ENV_ID" \
              --integration-id "$POSTMAN_INTEGRATION_ID" \
              --reporters cli,json \
              --reporter-json-export results.json || true
          '''
        }
      }
    }

    stage('Set Build Name with Test Execution Key') {
      steps {
        script {
          def execKey = 'UNKNOWN'
          try {
            def results = readJSON file: 'results.json'
            if (results.run?.meta?.collectionName) {
              def collectionName = results.run?.meta?.collectionName
              def matcher = collectionName =~ /\[(\w+-\d+)\]\[(\w+-\d+)\]/
              if (matcher) {
                execKey = matcher[0][1]
              } else {
                echo "⚠️ Warning: Postman collection name missing [TE-xx] key pattern."
              }
            } else {
              echo "⚠️ Warning: results.json missing collection name."
            }
          } catch (Exception e) {
            echo "⚠️ Warning: Failed to read or parse results.json: ${e}"
          }
          currentBuild.displayName = "${execKey} #${env.BUILD_NUMBER}"
        }
      }
    }

    stage('Install Node.js Dependencies') {
      steps {
        sh 'npm install'
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
            export JIRA_API_TOKEN=$JIRA_API_TOKEN
            export XRAY_CLIENT_ID=$XRAY_CLIENT_ID
            export XRAY_CLIENT_SECRET=$XRAY_CLIENT_SECRET
            export JIRA_BASE_URL=$JIRA_BASE_URL
            export JIRA_USER=$JIRA_USER
            export JIRA_PROJECT_KEY=$JIRA_PROJECT_KEY
            export BUG_ISSUE_TYPE=$BUG_ISSUE_TYPE
            export XRAY_BASE_URL=$XRAY_BASE_URL

            node scripts/sync_xray_jira.js results.json || echo "⚠️ Warning: sync_xray_jira.js failed but pipeline will not fail."
          '''
        }
      }
    }

 stage('Send Summary Email') {
  steps {
    withCredentials([
      usernamePassword(credentialsId: 'EMAIL_CREDENTIALS', usernameVariable: 'USER_EMAIL', passwordVariable: 'USER_PASS')
    ]) {
      sh '''
        set -ex
        echo "DEBUG - USER_EMAIL: $USER_EMAIL"
        echo "DEBUG - USER_PASS: ${USER_PASS:+Present}"

        USER_EMAIL=$USER_EMAIL USER_PASS=$USER_PASS node scripts/send-email.js
      '''
    }
  }
}


	

stage('Debug Env') {
  steps {
    withCredentials([
      string(credentialsId: 'USER_EMAIL', variable: 'USER_EMAIL'),
      string(credentialsId: 'USER_PASS', variable: 'USER_PASS')
    ]) {
      sh '''
        echo "EMAIL: $USER_EMAIL"
        echo "PASS: ${USER_PASS:+Present}"
        node -e "console.log('Node sees:', process.env.USER_EMAIL, process.env.USER_PASS ? 'Present' : 'Missing')"
      '''
    }
  }
}


    stage('Archive Results') {
      steps {
        archiveArtifacts artifacts: 'results.json', onlyIfSuccessful: false
      }
    }
  }
}
