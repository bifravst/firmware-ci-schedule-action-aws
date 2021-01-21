import * as chalk from 'chalk'
import { promises as fs } from 'fs'
import {
	certsDir as provideCertsDir,
	deviceFileLocations,
	caFileLocations,
	createCA,
	createDeviceCertificate,
} from '@bifravst/aws'
import {
	IoTClient,
	DescribeThingCommand,
	CreateJobCommand,
} from '@aws-sdk/client-iot'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import {
	S3Client,
	DeleteObjectCommand,
	PutObjectCommand,
} from '@aws-sdk/client-s3'
import { CloudFormationClient } from '@aws-sdk/client-cloudformation'
import {
	IoTDataPlaneClient,
	GetThingShadowCommand,
} from '@aws-sdk/client-iot-data-plane'
import { schedule, wait, cancel } from '@bifravst/firmware-ci-runner-aws'
import fetch from 'node-fetch'
import { v4 } from 'uuid'
import { TextDecoder } from 'util'
import { HttpRequest } from '@aws-sdk/protocol-http'
import { stackOutput } from '@bifravst/cloudformation-helpers'
import { getInput } from '@actions/core'

const getRequiredInput = (input: string): string =>
	getInput(input, { required: true })

const target = getRequiredInput('target')
const network = getRequiredInput('network')
const secTag = parseInt(getRequiredInput('sec tag'), 10)
const timeoutInMinutes = parseInt(getRequiredInput('timeout in minutes'), 10)

const jobId = getRequiredInput('job id')
const appVersion = getRequiredInput('app version')
const hexFile = getRequiredInput('hex file')
const fotaFile = getRequiredInput('fota file')
const fotaFilename = `${jobId.substr(0, 8)}.bin`

const testEnv = {
	accessKeyId: getRequiredInput('aws access key id'),
	secretAccessKey: getRequiredInput('aws secret access key'),
	region: getRequiredInput('aws region'),
	endpoint: getRequiredInput('broker hostname'),
	stackName: getRequiredInput('stack name'),
	firmwareCIDeviceId: getRequiredInput('firmware ci device id'),
}

const testEnvSDKConfig = {
	region: testEnv.region,
	credentials: {
		accessKeyId: testEnv.accessKeyId,
		secretAccessKey: testEnv.secretAccessKey,
	},
}

const s3 = new S3Client(testEnvSDKConfig)

const main = async () => {
	const { Account } = await new STSClient(testEnvSDKConfig).send(
		new GetCallerIdentityCommand({}),
	)

	const ciDeviceArn = `arn:aws:iot:${testEnv.region}:${Account}:thing/${testEnv.firmwareCIDeviceId}`

	const { bucketName } = await stackOutput(
		new CloudFormationClient(testEnvSDKConfig),
	)<{ bucketName: string }>(`${testEnv.stackName}-firmware-ci`)

	if (Account === undefined)
		throw new Error(`Could not authenticate against test environment!`)

	const certsDir = await provideCertsDir({
		accountId: Account,
		iotEndpoint: testEnv.endpoint,
	})

	console.error(chalk.yellow('Account:       '), chalk.blue(Account))
	console.error(chalk.yellow('Region:        '), chalk.blue(testEnv.region))
	console.error(chalk.yellow('Stack:         '), chalk.blue(testEnv.stackName))
	console.error(chalk.yellow('IoT Endpoint:  '), chalk.blue(testEnv.endpoint))
	console.error(chalk.yellow('Certificates:  '), chalk.blue(certsDir))
	console.error(chalk.yellow('Bucket:        '), chalk.blue(bucketName))
	console.error(chalk.yellow('Device Arn:    '), chalk.blue(ciDeviceArn))
	console.error(chalk.yellow('Job ID:        '), chalk.blue(jobId))
	console.error('')

	const iot = new IoTClient(testEnvSDKConfig)

	let jobInfo
	// Job exists?
	try {
		jobInfo = await wait({
			iot,
			jobId,
			interval: 10,
			timeoutInMinutes,
		})
	} catch (err) {
		if (!/Timed out/.test(err.message)) {
			console.error(chalk.magenta('Uploading firmware...'))
			// FIXME: remove when https://github.com/aws/aws-sdk-js-v3/issues/1800 is fixed
			s3.middlewareStack.add(
				(next) => async (args) => {
					delete (args.request as HttpRequest).headers['content-type']
					return next(args)
				},
				{ step: 'build' },
			)

			await Promise.all([
				s3.send(
					new PutObjectCommand({
						Bucket: bucketName,
						Key: `${jobId}.hex`,
						Body: await fs.readFile(hexFile),
						ContentType: 'text/octet-stream',
					}),
				),
				s3.send(
					new PutObjectCommand({
						Bucket: bucketName,
						Key: fotaFilename,
						Body: await fs.readFile(fotaFile),
						ContentType: 'text/octet-stream',
					}),
				),
			])

			const ca = caFileLocations(certsDir)

			try {
				await fs.stat(ca.id)
			} catch {
				console.error(chalk.magenta('Generating CA certificate...'))
				await createCA({
					certsDir,
					iot: new IoTClient(testEnvSDKConfig),
					cf: new CloudFormationClient(testEnvSDKConfig),
					stack: testEnv.stackName,
					subject: `firmware-ci-${v4()}`,
					log: console.error,
					debug: console.debug,
					attributes: {
						test: 'firmware',
					},
				})
			}

			const AmazonRootCA1 = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----`

			await createDeviceCertificate({
				certsDir,
				deviceId: jobId,
				mqttEndpoint: testEnv.endpoint,
				awsIotRootCA: AmazonRootCA1,
			})

			const deviceCert = deviceFileLocations({
				certsDir,
				deviceId: jobId,
			})

			// Writes the JSON file which works with the Certificate Manager of the LTA Link Monitor
			await fs.writeFile(
				deviceCert.json,
				JSON.stringify(
					{
						caCert: AmazonRootCA1,
						clientCert: await fs.readFile(deviceCert.certWithCA, 'utf-8'),
						privateKey: await fs.readFile(deviceCert.key, 'utf-8'),
						clientId: jobId,
						brokerHostname: testEnv.endpoint,
					},
					null,
					2,
				),
				'utf-8',
			)

			const jobDocument = await schedule({
				bucketName: bucketName,
				certificateJSON: deviceCert.json,
				ciDeviceArn,
				firmwareUrl: `https://${bucketName}.s3.${testEnv.region}.amazonaws.com/${jobId}.hex`,
				network,
				secTag,
				region: testEnv.region,
				s3: new S3Client(testEnvSDKConfig),
				target,
				iot,
				jobId,
				timeoutInMinutes,
				abortOn: getRequiredInput('abort on')
					.split('\n')
					.map((s) => s.trim())
					.filter((s) => s),
				endOn: getRequiredInput('end on')
					.split('\n')
					.map((s) => s.trim())
					.filter((s) => s),
			})

			await fs.writeFile(
				'jobDocument.json',
				JSON.stringify(jobDocument, null, 2),
				'utf-8',
			)
			console.error(
				chalk.magenta('Stored job document in'),
				chalk.blueBright('jobDocument.json'),
			)

			// Inject behaviour once the device connects
			const iotDataTestEnv = new IoTDataPlaneClient({
				...testEnvSDKConfig,
				endpoint: `https://${testEnv.endpoint}`,
			})
			const iotTestEnv = new IoTClient(testEnvSDKConfig)
			let timeLeft = timeoutInMinutes * 60 - 60
			const scheduleFOTA = async () => {
				process.stderr.write(
					chalk.magenta(`Checking if device has connected ... `),
				)

				const reschedule = () => {
					timeLeft -= 10
					if (timeLeft > 0) {
						setTimeout(scheduleFOTA, 10 * 1000)
					} else {
						console.error(
							chalk.red(
								'Device did not connect within ${timeoutInMinutes} minutes.',
							),
						)
					}
				}

				try {
					const shadow = await iotDataTestEnv.send(
						new GetThingShadowCommand({
							thingName: jobId,
						}),
					)
					const { state } = JSON.parse(
						new TextDecoder('utf-8').decode(shadow.payload),
					)
					console.error(chalk.green(`Device has connected.`))
					if (state?.reported?.dev === undefined) {
						console.error(
							chalk.red(`Device has not reported device information, yet.`),
						)
						reschedule()
						return
					}
					// Schedule FOTA job
					const { thingArn } = await iotTestEnv.send(
						new DescribeThingCommand({
							thingName: jobId,
						}),
					)
					if (thingArn === undefined)
						throw new Error(`Failed to describe thing ${jobId}!`)

					const stat = await fs.stat(fotaFile)
					const fotaJobDocument = {
						operation: 'app_fw_update',
						size: stat.size,
						filename: fotaFilename,
						location: {
							protocol: 'https',
							host: `${bucketName}.s3-${testEnv.region}.amazonaws.com`,
							path: fotaFilename,
						},
						fwversion: `${appVersion}-upgraded`,
						targetBoard: '9160DK',
					}
					await fs.writeFile(
						'fotaJobDocument.json',
						JSON.stringify(fotaJobDocument, null, 2),
						'utf-8',
					)
					console.error(
						chalk.magenta('Stored FOTA job document in'),
						chalk.blueBright('fotaJobDocument.json'),
					)
					const job = await iotTestEnv.send(
						new CreateJobCommand({
							jobId: v4(),
							targets: [thingArn],
							document: JSON.stringify(fotaJobDocument),
							description: `Upgrade ${
								thingArn.split('/')[1]
							} to version ${appVersion}-upgraded.`,
							targetSelection: 'SNAPSHOT',
						}),
					)
					console.error(chalk.green(`FOTA job created.`))
					console.log({ job })
				} catch (err) {
					console.error(chalk.red(`Device has not connected, yet.`))
					console.error(chalk.red(err.message))
					reschedule()
				}
			}
			setTimeout(scheduleFOTA, 60 * 1000)
		}

		try {
			// Wait for the job to complete
			jobInfo = await wait({
				iot,
				jobId,
				interval: 10,
				timeoutInMinutes: timeoutInMinutes * 2,
			})
		} catch {
			console.error(chalk.red(`Timeout waiting for job to complete.`))
			await cancel({ iot, jobId })
		}

		// Delete
		await Promise.all([
			s3.send(
				new DeleteObjectCommand({
					Bucket: bucketName,
					Key: `${jobId}.hex`,
				}),
			),
			s3.send(
				new DeleteObjectCommand({
					Bucket: bucketName,
					Key: fotaFilename,
				}),
			),
		])
	}

	if (jobInfo !== undefined) {
		const report = JSON.parse(
			await (await fetch(jobInfo.jobDocument.reportUrl)).text(),
		)
		await fs.writeFile('report.json', JSON.stringify(report, null, 2), 'utf-8')
		console.error(
			chalk.magenta('Stored report in'),
			chalk.blueBright('report.json'),
		)
		const { result, flashLog, deviceLog } = report
		console.log()
		console.log('** Result **')
		console.log()
		console.log(result)
		console.log()
		console.log('** Flash Log **')
		console.log()
		console.log(flashLog.join('\n'))
		console.log()
		console.log('** Device Log **')
		console.log()
		console.log(deviceLog.join('\n'))
	}
}

void main()
